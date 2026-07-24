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
- [x] 動画編集 段階1: ブラウザ内レンダラー（/media/[id]。承認済み台本＋素材を
      Canvas+MediaRecorder で WebM 書き出し・字幕SRT・ナレーション原稿出力・
      YouTube動画ID手動登録で uploaded/published へ）
- [x] 勤怠・シフト（0013 / /hr。HRMOS勤怠のシフト管理を参考）: シフトパターン・
      希望シフト収集・月間シフト表・打刻実績（punch.html の attendance）との
      予実比較。予定は既存 shifts テーブルに書く（docs/09 Step 2.5）
- [x] 受注管理（/orders。タノムを参考）: order-portal.html から入った注文の
      ステータス管理（受注→確認済→発送済→納品完了）・顧客別/品目別集計・
      CSVエクスポート
- [x] 帳票発行（0014）: 注文から請求書・納品書・領収書を発行。月毎・種類毎の
      自動採番（INV-202607-001形式）、ファイル名は任意（PDF保存時の既定名）、
      内税8%/10%/0の消費税逆算、発行時スナップショット、取消は欠番扱い。
      印刷ページ + print CSS でPDF化。発行者情報は既存 org_settings と共用
- [x] スタッフ共有ボード（0015 / /board）: 代表の共有・指示 → 役割
      （staff.role、/boardから設定可）で宛先を絞る。辞書ベース自動タグ +
      検索・タグ絞り込み。ダッシュボードに最新3件表示。モバイル下部タブ入り
- [x] 飲食店共有ボード（0015 / /portal/board?token=）: 精肉在庫スナップショット
      添付・信頼度（初回/リピーター/太客）で配信先を絞る。認証は既存
      customers.portal_token（注文ポータルと同じ・ログイン不要の店別URL）
- [x] 投稿一括更新（0015 / /social）: 一次データ → HP/Instagram/FB/YouTube向け
      原稿をAI生成 → 承認 → コピー投稿 + 投稿済み管理
- [x] 売上伝票（0016 / /ledger）: 手売り・解体体験・イベント販売の
      スマホ入力伝票。月毎自動採番・取消=欠番・月次集計・税理士用CSV
- [x] 士業相談（0016 / /advisor）: 税務/労務/法務/知財/行政の一次整理。
      論点・準備書類・専門家への質問リストをAI生成（法的助言ではない）→
      承認 → 相談文一式コピー → 専門家の回答を記録してクローズ
- [x] 里山OS MVP（0019 / /nature/quick・/nature/gaps、docs/10）:
      種マスタ（希少度）・観察記録の拡張（証拠種別/信頼度A〜E/レビュー/公開範囲）・
      位置情報マスキング（希少種は座標非表示）・現場メモのAI整理（候補のみ）・
      調査ギャップ（分類群×季節）と有限タスク提案
- [x] 帳票センター（0017 / /billing、Misoca代替）: 見積書追加（QT採番）、
      注文に紐づかない自由入力発行（明細エディタ）、書類変換
      （見積→納品/請求→領収、明細引き継ぎ・系譜記録）、
      Misoca CSVインポート（列名揺れ吸収・重複スキップ・金額原本保持）

## Phase 3: 現場仕様に育てる — Opus

- メディア段階2: 動画の高品質レンダリング（段階1のブラウザ版を ffmpeg /
  Remotion 等のサーバーレンダラーに置換。TTSナレーション合成）と
  YouTube Data API での自動アップロード（要 Google Cloud OAuth。
  入力は video_plan の script 構造をそのまま使う。公開操作は人間承認後のみ）
- 勤怠・シフト拡張: シフトの下書き→公開フロー、打刻修正申請、休暇管理、
  給与計算用の月次集計エクスポート（staff.hourly_wage は既存テーブルにある）
- 受注管理拡張（タノム寄せ）: 定番注文・締め時間・発注リマインド
  （LINE通知は /api/line の基盤を流用）、複数注文をまとめた月締め請求書
- 投稿一括更新 段階2: Meta Graph API（Instagram/Facebook自動投稿）、
  YouTube Data API、HPのCMS API接続。音声・動画の自動文字起こし。
  ※自動投稿は必ず承認済み原稿のみ・実行ログを audit_logs に残すこと
- 共有ボード拡張: 既読管理、スタッフごとのログイン招待、AI提案タグ
  （承認フロー経由）、注文ポータル（order-portal.html）からボードへのリンク設置
- 経理拡張: 会計ソフト連携（freee/マネーフォワードAPI等）、売上伝票の
  在庫連動（products.stock_qty 減算はムーブメント設計の確認が必要 —
  既存 product_movements と衝突しないこと）、経費・仕入れ伝票
- 里山OS Phase 2〜5（docs/10 参照）: 竹林・堅果・胃内容物の専門調査票、
  捕獲/検体記録、調査キャンペーンUI、食物網ビュー、実績・称号、
  センサーカメラ・ドローン統合、デジタルツイン。
  **位置に関わる追加は必ず geo-masking を通し、テストを追加すること**
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
