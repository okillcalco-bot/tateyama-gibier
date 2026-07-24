# 10. 里山OS（Satoyama OS）

館山・南房総の里山を対象に、「地域で何が分かっていて、何がまだ分かっていないか」を
可視化するモジュール。設計指示書 v2.0（沖浩志作成）を ALCO OS に組み込んだもの。

**ALCO OS の一部として実装する**（別システムを作らない）。既存の自然資本モジュール
（0004: sites / survey_points / field_surveys / biodiversity_observations /
management_actions）を土台に拡張している。

## 設計憲章（実装上の意味）

| 原則 | 実装 |
|---|---|
| 自然保全優先 | 希少種は投稿時点で自動的に restricted。座標は出さない |
| 証拠と推定の分離 | `source_type`（observed / ai_suggested / literature / expert / hearsay）と `ai_suggestion` 列を分ける |
| 位置情報の最小公開 | `geo-masking.ts` + SQL `mask_coordinate()`。公開座標は原座標から都度生成し複製しない |
| 参加しやすさ | /nature/quick は写真・GPS・種名だけで登録可（3タップ） |
| 科学的更新性 | `confidence.ts` はレビュー・証拠追加で再計算。バージョンを保存 |
| 説明可能性 | 信頼度は要素分解して `confidence_factors` に保存し、UIで内訳を出す |
| モジュール性 | domain/satoyama/ に閉じ、他モジュールへ依存しない |

## 実装済み（MVP / P0・P1の中核）

| 対象 | 実装 |
|---|---|
| DB | 0019: `taxa`（希少度）/ `evidence` / `ecological_interactions`（※CRMの `interactions` と衝突するため接頭辞）/ `survey_campaigns` / `survey_tasks` + `biodiversity_observations` の列拡張 |
| 位置マスキング | `domain/satoyama/geo-masking.ts`（感度×権限→精度）、SQL `mask_coordinate()`、公開ビュー `v_public_observations` |
| 信頼度 | `domain/satoyama/confidence.ts`（6要素の加重・A〜E・バージョン付き） |
| 調査ギャップ | `domain/satoyama/knowledge-gap.ts`（分類群×季節、有限タスク提案） |
| 観察・レビュー | `domain/satoyama/observation-service.ts`（希少種の自動保護・レビュー・証拠追加・種マスタ） |
| AI整理 | `ai/workflows/parse-field-note.ts`（候補のみ生成。危険語はサーバー側でも検知して保護側に倒す） |
| 画面 | `/nature/quick`（かんたん投稿 S02・レビュー S08・種マスタ）、`/nature/gaps`（調査ギャップ S07） |

## 位置情報の公開粒度（14章の実装）

| 感度 | public | members | restricted / owner |
|---|---|---|---|
| normal（一般種） | 1kmメッシュ | 0.1kmメッシュ | 原座標 |
| caution（要注意種） | 5kmメッシュ | 1kmメッシュ | 原座標 |
| sensitive（希少種・営巣地・罠） | **非表示** | **非表示** | 原座標 |

実装ルール（変更禁止）:
- **UIへ渡す前に必ず `maskObservationPoint()` を通す。** ページで生の lat/lng を描画しない
- CSV/GeoJSON 出力も `toExportRow()` を通す（原座標を出力しない）
- 感度の判定は `effectiveSensitivity(観察の上書き, 種マスタ)`。不正値は normal ではなく安全側に倒す設計
- 罠・捕獲地点は sensitive 相当として扱う

## AIガードレール（19章の実装）

- `parse_field_note` は種を確定しない（`species_candidates` は配列・`needs_expert_review`）
- 「営巣・繁殖地・罠・私有地・希少」等のキーワードを**サーバー側でも**検知し、
  AIが `sensitivity_flag=false` を返しても true に上書きする（`detectSensitiveKeywords`）
- AI出力は `generated_drafts` に入り、承認センターを通るまで観察記録にならない
- AIが生成した調査タスクは `survey_tasks.approved_by` が入るまで公開しない

## 未実装（設計書のロードマップ。Opusで段階実装）

- Phase 2: 竹林・堅果・胃内容物の専門調査票、捕獲記録（`capture_records` / `specimen_records`）、調査キャンペーンUI
- Phase 3: 食物網ビュー（`ecological_interactions` は器のみ実装済み）、実績・称号、知識スコア
- Phase 4: 気象・ドローン・センサーカメラ統合、予測モデル
- Phase 5: 3D/デジタルツイン、バーチャルツアー、TNFD活用

追加時の注意:
- 位置に関わる新機能は必ず geo-masking を通す。テスト（tests/domain/satoyama.test.ts）を必ず追加する
- PostGIS は未導入。メッシュ丸めで足りる範囲で実装し、必要になった時点で
  docs/02-architecture.md を更新してから導入する
- `ecological_interactions` に食物網を足すときは、エッジに証拠・信頼度・公開範囲を必ず持たせる
