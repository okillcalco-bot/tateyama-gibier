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

## クエスト & 応援（0020）— 「応援が地域の仕事になる」循環

```
外部の応援（支援金） → クエストの資金 → 調査の実施（地域の調査員へ謝金）
      ↑                                              ↓
   成果報告・進捗メーター・称号  ←  観察記録・ギャップが埋まる
```

| 対象 | 実装 |
|---|---|
| クエスト | `survey_tasks` を拡張（target_count / progress_count / funding_goal_yen / funded_yen / paid_out_yen / reward_title / public_slug / published_at / story） |
| 応援 | `supporters` + `support_pledges`（pledged → confirmed で初めて資金に計上） |
| 地域の仕事 | `quest_payouts`（調査員への謝金・交通費。**入金確認額を超える支払いは不可**） |
| 称号 | `achievements.ts`（定義）+ `achievement_grants`（付与記録） |
| 社内画面 | `/nature/gaps`（クエストボード: 地域レベル・進捗バー・応援メーター・入金確認・支払い記録） |
| 公開画面 | `/support/[slug]`（ログイン不要。応援フォーム・進捗・使いみち・応援者一覧） |

### ゲーミフィケーションの制約（設計書10章。破らないこと）

- **希少種クエストは公開・募集・応援の対象にしない**。`publishQuest()` が
  `restricted=true` を拒否し、公開ビュー `v_public_quests` にも含めない（二重の防御）
- 公開ページに**位置情報を一切出さない**（クエストは分類群・季節までしか持たない）
- 称号は投稿数で付けない。季節の継続・証拠の多様性・レビュー承認率で判定する
  （希少種の発見を報酬対象にしない = 乱獲・位置暴露の誘発を防ぐ）
- 個人ランキングを画面に出さない。**地域レベル（communityLevel）と共同達成**を前面に置く

### お金の不変条件（funding-service）

- `pledged`（表明）は資金に数えない。`confirmed`（入金確認）で初めて `funded_yen` に加算
- `paid_out_yen + 新規支払い <= funded_yen`（超過は例外で拒否）
- 支払い済みを下回る応援取消・返金は拒否
- 金額の増減はすべて `audit_logs` に残す（削除しない）
- 決済プロバイダ（Stripe等）連携は**段階2**。現状は振込・現地払いを人が確認する運用

## 未実装（設計書のロードマップ。Opusで段階実装）

- Phase 2: 竹林・堅果・胃内容物の専門調査票、捕獲記録（`capture_records` / `specimen_records`）、調査キャンペーンUI
- Phase 3: 食物網ビュー（`ecological_interactions` は器のみ実装済み）、実績・称号、知識スコア
- Phase 4: 気象・ドローン・センサーカメラ統合、予測モデル
- Phase 5: 3D/デジタルツイン、バーチャルツアー、TNFD活用
- 応援まわり段階2: Stripe等のオンライン決済（webhookで自動 confirm）、
  領収書の自動発行（/billing の billing_documents を流用）、
  応援者へのメール成果報告、企業協賛プラン、図鑑カード（種ごとの解明度可視化）

## 捕獲者LINE（0021）での位置情報の扱い

捕獲者からのLINE連絡には捕獲場所・わなの位置が含まれることがある。
これは本章の **sensitive 相当**（罠・捕獲地点）として扱う。

- `line_inbound_messages` に緯度経度の列を作らない（`has_location` フラグのみ）。
  原座標は業務レコードである `capture_reports.capture_lat/lng` にだけ持つ
  （既存 `individuals.capture_lat/lng` と同じ扱い）
- `/gibier/reports` は `maskObservationPoint({sensitivity:'sensitive'}, 'restricted')`
  を通してから座標を表示し、「外部に出さない」警告を必ず添える。
  CSV・GeoJSON への書き出しは行わない
- `/line` 画面は位置情報つきの連絡に「地図・座標を貼らない」警告を出す
- 観察記録として残す場合は、必ず既存の観察ルート
  （`biodiversity_observations` + `maskObservationPoint()`）に載せる。
  LINE由来のデータを直接公開系へ流さない
- `classify_hunter_message` は「わな・捕獲地点・私有地」等の語、または
  位置情報の添付があれば `sensitivity_flag` を強制的に true にする
  （`detectSensitiveKeywords` を parse_field_note と共用）

追加時の注意:
- 位置に関わる新機能は必ず geo-masking を通す。テスト（tests/domain/satoyama.test.ts）を必ず追加する
- PostGIS は未導入。メッシュ丸めで足りる範囲で実装し、必要になった時点で
  docs/02-architecture.md を更新してから導入する
- `ecological_interactions` に食物網を足すときは、エッジに証拠・信頼度・公開範囲を必ず持たせる
