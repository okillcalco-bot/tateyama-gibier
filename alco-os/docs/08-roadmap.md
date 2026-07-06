# 08. ロードマップ

## Phase 1: 骨格（本コミットで完了）— Fable

- [x] モノレポ内 alco-os/ プロジェクト（Next.js + TS + Tailwind + Supabase）
- [x] 設計ドキュメント一式（docs/00〜09）+ CLAUDE.md + README
- [x] Core スキーマ + RLS（organizations / profiles / roles / tasks / files / ai_runs / audit_logs / generated_drafts）
- [x] 全モジュールのDBスキーマ（Voice Memo / Grants / Nature / CRM / Projects / HR / Documents）
- [x] AI adapter 層（model-router / providers / workflows / prompts / schemas）
- [x] ドラフト承認フロー（draft-service）+ 監査ログ + 証跡チェック
- [x] 画面MVP: ダッシュボード / メモ / 承認センター / タスク / 補助金 / 自然資本 / CRM / プロジェクト / ジビエ入口 / ログイン
- [x] ユニットテスト20件 + e2eスモーク + seed
- [x] Opus 保守ガイド

## Phase 2: 立ち上げ

- [x] 本番 Supabase（tateyama-gibier）へ 0001〜0009 適用
      （既存テーブル無変更。documents 衝突を検出し knowledge_docs に改名）
- [x] auth middleware（未ログインリダイレクト・セッションリフレッシュ）
- [x] プロフィール自動プロビジョニング（初回ログインで profiles + ロール自動作成。
      最初のユーザー = owner）
- [x] 承認権限の絞り込み（owner / manager のみ。RLS + server action）
- [x] Grants: 案件登録・要件チェックリスト（充足トグル）・申請書ドラフト生成
      ボタン・承認センターでの本文プレビュー
- [x] Nature: 対象地登録・観察記録のモバイル入力（写真アップロード+GPS取得）・
      管理作業記録・レポートドラフト生成（証跡IDの実在チェックを保存前に強制）
- [x] Storage 非公開バケット + RLS（0010。証跡写真はオブジェクト削除不可）
- [ ] Supabase Dashboard で代表のユーザーを作成 → ログイン確認
- [ ] Vercel デプロイ（環境変数: NEXT_PUBLIC_SUPABASE_URL /
      NEXT_PUBLIC_SUPABASE_ANON_KEY / AI_PROVIDER / AI_DEFAULT_MODEL / ANTHROPIC_API_KEY）
- [x] 本番AI稼働確認（anthropic / claude-sonnet-5 で分類成功。2026-07-05）
- [x] タスクの完了・着手操作（/tasks に完了ボタン）
- [x] 受信箱API（/api/inbox）— 外部テキストの取り込み + 自動AI分類。
      INBOX_TOKEN + SUPABASE_SERVICE_ROLE_KEY で有効化
- [ ] iPhone共有ショートカットの設定（受信箱APIへ送る。README参照）
- [ ] LINE公式アカウント + Messaging API webhook → 受信箱への接続
      （/api/line 実装済み。LINE Developers 側の webhook URL 設定待ち）
- [ ] メール転送（inbound email サービス → 受信箱）
- [ ] Voice Memo の音声ファイルアップロード + 文字起こし連携
- [x] 運用開始（代表 owner 登録・メモ→承認→タスクの一周を本番確認）
- [x] メディアモジュール（0012）: プレゼン資料 = ブリーフ→AI構成→承認→PPTX
      ダウンロード / YouTube動画 = ブリーフ→AI台本・メタデータ（タイトル案・
      概要欄・タグ・チャプター・サムネ文言）→承認。素材割付は添付ファイル名の
      実在チェック付き

## Phase 3: 現場仕様に育てる — Opus

- メディア段階2: 動画の自動レンダリング（台本+素材→動画ファイル。TTS/字幕）と
  YouTube Data API での自動アップロード（要 Google Cloud OAuth。
  status: approved → rendering → uploaded → published、youtube_video_id に記録。
  公開操作は人間承認後のみ）
- 帳票・ラベル・CSV入出力の拡充
- CRM: お礼メール下書き生成・BNI 1to1記録
- Projects: ROKA専用テンプレ・見積比較
- HR: チェックリスト実施のモバイルUI・SOP整備
- Documents: 検索・AI参照資料の投入
- ダッシュボード: グラフ・月次レポート文面

## Phase 4: ジビエ統合（docs/09 の Step 2〜3）

- v_gibier_* KPIビュー追加（捕獲頭数・在庫金額・歩留まり・売上）
- 既存テーブルへの organization_id 付与と RLS 統一
- 既存静的アプリの機能を ALCO OS へ段階移行（現場が困らない速度で）

## Phase 5: 発展

- 自然共生サイト申請パッケージ生成 / 地図連携（PostGIS）
- 生物多様性クレジット証跡管理
- BI連携（経営数字のエクスポート基盤はビューで準備済み）
- 実運用データでのプロンプト改善サイクル
