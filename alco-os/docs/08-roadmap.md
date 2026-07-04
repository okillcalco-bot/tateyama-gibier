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

## Phase 2: 立ち上げ（次にやること）— Opus 中心

1. Supabase プロジェクトへのマイグレーション適用 + 初期ユーザー作成
2. auth middleware（未ログインリダイレクト・セッションリフレッシュ）
3. 承認権限の絞り込み（manager 以上のみ承認可）
4. Voice Memo の音声ファイルアップロード + 文字起こし連携
5. Grants: 要件チェックリストUI・ドラフト生成ボタン・レビュー画面
6. Nature: 観察記録のモバイル入力フォーム（写真+GPS）・レポート生成UI
7. Vercel デプロイ + 運用開始（まずは代表のメモ運用から）

## Phase 3: 現場仕様に育てる — Opus

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
