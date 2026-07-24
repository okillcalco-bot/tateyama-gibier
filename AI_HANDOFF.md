# AI引き継ぎ文書 — 合同会社アルコ システム一式

> この文書は、合同会社アルコ（千葉県館山市・代表 沖浩志）のシステムを
> **AIモデル（Claude Opus / その他）に引き継ぐための自己完結サマリー**です。
> リポジトリにアクセスできる場合は、作業前に必ず
> `alco-os/docs/00-philosophy.md`（思想・優先順位）→ `alco-os/CLAUDE.md` →
> `alco-os/docs/07-opus-maintenance-guide.md` の順に読んでください。
> 最終更新: 2026-07-12（Fable 5 作成）

## 思想（要約 — 全文は docs/00-philosophy.md）

ALCO OS は「地域の自然資本を未来へ引き継ぐために、人の仕事をAIで支える」地域OS。
AIは提案者であり、判断者・承認者ではない。迷ったときの優先順位:
**①現場が止まらない → ②データが壊れない → ③セキュリティ → ④保守性 →
⑤AI品質 → ⑥UI → ⑦新機能**。
新しく作るより既存を活かす / 削除より履歴 / 自動化より人間の承認 /
派手さより安全。大規模リファクタリング禁止。

## 会社の事業（前提知識）

館山ジビエセンター（有害鳥獣の処理加工・販売）/ 里山保全 /
自然共生サイト・TNFD支援 / R.O.K.A.（遊休施設リノベーション）/ 補助金伴走支援 /
講演・発信。現場はスマホ利用が基本（モバイルファースト必須）。

## リポジトリ構成（okillcalco-bot/tateyama-gibier）

| 場所 | 内容 | 状態 |
|---|---|---|
| ルート直下 `*.html` | **ジビエ基幹システム**（個体管理 index.html / 捕獲 capture-form.html / 注文ポータル order-portal.html / 打刻 punch.html 等の静的PWA + Supabase直結） | **本番稼働中。壊すの厳禁** |
| `alco-os/` | **ALCO OS** — 業務OS本体（Next.js 15 + TypeScript + Tailwind v4 + Supabase + Zod + Vitest + pnpm） | 本番稼働中 |
| `profile/` | 代表のプロフィールサイト（profile.json → build.js → dist/ の静的生成。sharp画像処理） | 本番稼働中 |
| `migrations/` | ジビエ基幹側のSQL（追加のみ） | 既存流儀 |

## 本番環境

- ALCO OS: https://alco-os.vercel.app（Vercelプロジェクト alco-os、Root Directory=`alco-os`）
- プロフィール: Vercel別プロジェクト（Root Directory=`profile`）
- Supabase: プロジェクト `clpdyrehdgzgiidbfucj`（**ジビエ基幹と共有**。個体340件・捕獲者206名等の実データあり。ダミーデータ投入禁止）
- ブランチ運用: `claude/alco-os-architecture-n56n5z` で開発 → PR → main マージ → Vercel自動デプロイ

## 絶対ルール（違反禁止）

1. **AI出力は必ず `generated_drafts` に draft 保存 → 人間承認 → 業務テーブル反映。** 反映経路は `draft-service.approveDraft()` のみ
2. AI実行は成功・失敗とも `ai_runs` に記録。重要な業務変更は `audit_logs` に記録（両テーブルとも削除・改変機能を作らない）
3. ジビエ基幹の既存テーブル（individuals / hunters / staff / attendance / shifts / products / orders / order_items / customers / org_settings 等）は**スキーマ変更禁止**。行の読み書きは許可されたもののみ（下記「統合ポイント」）
4. マイグレーションは追加のみ（`alco-os/supabase/migrations/` 連番。既存ファイル編集禁止）。新テーブルは organization_id + `alco_add_member_policy('<table>')` + set_updated_at トリガー
5. モデル名ハードコード禁止（env + `src/ai/model-router.ts`）。最新Claudeモデルは temperature 非対応（送ると400）
6. UIは日本語、コード・DB名は英語。ビジネスロジックは `src/domain/`（DbPort依存・Supabase直接依存禁止）
7. server action のエラーは throw せず ActionResult 型で返す（本番Nextはエラー内容をマスクするため）
8. 補助金・行政文書はAI生成をそのまま提出しない。service_role キーはVercel環境変数のみ
9. 機能変更時は docs/ と スタッフ用マニュアル `/manual`（src/app/manual/page.tsx）を同じPRで更新

## ALCO OS モジュール一覧（実装済み）

| ルート | 機能 |
|---|---|
| `/` | ダッシュボード（KPI + ジビエ基幹集計ビュー v_gibier_* + 共有ボード最新） |
| `/board` | 共有ボード。スタッフ向け（宛先=staff.role）/ 飲食店向け（宛先=customer_levels.tier: new/repeat/vip）。タグは辞書ベース自動付与（domain/board TAG_RULES）+検索 |
| `/portal/board?token=` | 飲食店閲覧ページ。既存 customers.portal_token 認証・ログイン不要（middlewareで認証除外） |
| `/memos` | メモ → AI分類（classify_voice_memo）→ 承認 → タスク化 |
| `/tasks` | タスク（完了◯・着手） |
| `/drafts` | 承認センター（全AIドラフトの承認/破棄。owner/managerのみ） |
| `/grants` | 補助金（案件・要件チェック・申請書ドラフトAI生成） |
| `/nature` | 自然資本（観察記録+写真+GPS、レポートAI生成。証跡IDの実在チェックを保存前に強制） |
| `/crm` `/projects` | CRM / プロジェクト管理 |
| `/hr` | 勤怠・シフト（HRMOS参考）。予定=既存 shifts テーブル、実績=既存 attendance（読取専用）、パターン・希望=0013 |
| `/orders` | 受注管理（タノム参考）。既存 orders の status 更新のみ（語彙: 受注/確認済/発送済/納品完了/キャンセル — order-portal.html と共通、変更禁止）+ 集計 + CSV |
| `/orders` 内 帳票 | 請求書/納品書/領収書（0014 billing_documents）。月毎種類毎自動採番 INV/DN/RC-YYYYMM-001、発行時スナップショット、取消=欠番、内税逆算8/10/0%。印刷ページ=/orders/documents/[id] |
| `/media` | プレゼン（承認後PPTX: /api/media/[id]/pptx、pptxgenjs）/ YouTube動画プラン（台本・メタデータ + ブラウザ内WebM書き出し + SRT + 動画ID手動登録） |
| `/social` | 投稿一括更新。一次データ → HP/Instagram/FB/YouTube向け原稿AI生成 → 承認 → コピー投稿 + 投稿済み管理 |
| `/ledger` | 売上伝票（手売り/解体体験/イベント。SL-YYYYMM-###自動採番、取消=欠番、月次集計、税理士用CSV=/api/ledger/csv） |
| `/advisor` | 士業相談（税務/労務/法務/知財/行政の一次整理AI。法的助言ではない。承認→相談文コピー→専門家回答を記録） |
| `/manual` | スタッフ用マニュアル（静的。機能変更時に必ず更新） |
| `/api/inbox` | 汎用受信箱（INBOX_TOKEN認証。iPhoneショートカット等から） |
| `/api/line` | LINE Webhook（HMAC署名検証、既存GAS秘書へ転送共存、テキストをメモ化）※環境変数設定待ち |

## AIワークフロー（src/ai/。追加手順は docs/05）

classify_voice_memo / generate_grant_draft / generate_nature_report /
generate_presentation / generate_video_plan / generate_social_posts /
generate_advisor_brief。
共通ランナー runWorkflow が Zod検証・ai_runs記録・draft保存を強制。
実在チェック（写真名・証跡ID・依頼チャンネル）は superRefine で保存前拒否。
MockProvider は `[workflow:名前]` マーカーで応答を返す（テスト・キー無し開発用）。

## ジビエ基幹との統合ポイント（docs/09 Step 2.5）

- 既存 `shifts`: ALCO OSが正式採用（行の読み書き可。organization_id を書かない）
- 既存 `attendance`: 読み取り専用（punch.html が書く）
- 既存 `orders/order_items`: status更新のみ（domain/orders経由・監査ログ付き）
- 既存 `staff.role`: 共有ボードの宛先として値更新可
- 既存 `org_settings`: 帳票発行者情報のキー共用（org_name/org_postal/org_address/org_phone/invoice_number/org_bank_info）
- 既存 `customers.portal_token`: 飲食店ボードの認証に共用
- 在庫の正は products.stock_qty（KPIビュー v_gibier_* は読み取り専用）

## 環境変数（Vercel / .env.local。env.ts が全値をtrim）

NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY /
SUPABASE_SERVICE_ROLE_KEY / AI_PROVIDER(anthropic|mock) / AI_DEFAULT_MODEL /
ANTHROPIC_API_KEY / INBOX_TOKEN / LINE_CHANNEL_SECRET /
LINE_CHANNEL_ACCESS_TOKEN / GAS_WEBHOOK_URL

## DBマイグレーション状態

0001〜0016 本番適用済み（core / voice_memo / grants / nature / crm / projects /
hr_documents(※documentsは既存衝突のため knowledge_docs) / dashboard_views /
provisioning / storage / gibier_views / media / workforce / billing /
boards_social / ledger_advisor）。

## 未完・段階2（docs/08 Phase 2-3 参照）

- **LINE秘書の接続**: コードは完成。Vercel環境変数5つ + LINE DevelopersのWebhook URL切替が未実施（ユーザー作業待ち）
- 週次経営サマリーのLINE配信 / メール取込 / 音声・動画の自動文字起こし
- SNS自動投稿（Meta Graph API / YouTube Data API。**承認済み原稿のみ・監査ログ必須**）
- 動画のサーバーレンダリング・TTS / シフト公開フロー・給与集計 / 定番注文・リマインド / 月締め請求書
- 既知の警告: 既存テーブル `secretary_pages` がRLS無効（既存アプリ確認後に対応。ユーザー認知済み）

## 作業の切り分け

- **Opusで可**: 文言・項目追加、タグ辞書追加、帳票レイアウト、新画面・集計、
  プロンプト改善、既存パターンに沿った新AIワークフロー・新テーブル
- **Fable推奨**: 外部API認証設計（Meta/Google OAuth、メール取込）、権限モデル変更、
  ジビエ基幹画面のALCO OS移行設計、セキュリティに関わる変更

## 作業チェックリスト（毎回）

1. `alco-os/CLAUDE.md` と `docs/07` を読む
2. 変更は小さく。domain経由・監査ログ・承認フローを迂回しない
3. `pnpm typecheck && pnpm test`（現在49件）→ `pnpm build`
4. docs/ と /manual を更新 → PR（main直pushしない）
5. 報告: 変更概要 / ファイル / テスト / マイグレーション / リスク
