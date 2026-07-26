# 09. ジビエ基幹システム統合方針

## 現状

リポジトリルートの静的HTMLアプリ群（index.html, capture-form.html,
order-portal.html, punch.html 等）が **本番稼働中** のジビエ基幹システム。
Supabase プロジェクト（個体・捕獲者・スタッフ・勤怠・完成品在庫・受注・顧客）に
直接接続し、RLSは「有効化 + allow_all ポリシー」パターン。

主な既存テーブル:

| テーブル | 内容 |
|---|---|
| individuals | 個体（捕獲日・場所・獣種・体重・肉ランク・歩留まり・買取） |
| hunters | 捕獲者台帳（国産ジビエ認証様式対応） |
| staff / attendance | スタッフ・出退勤 |
| products / product_movements | 完成品マスタ・在庫移動ログ（append-only、source_ident_code でトレーサビリティ） |
| orders / customers | 受注・顧客 |
| area_master | 地区マスタ |

## 統合の原則

1. **現場を止めない。** 既存アプリ・既存テーブル・既存データは壊さない
2. 在庫はムーブメント（append-only）から算出する既存設計を維持する
3. トレーサビリティ（製品→個体）の連鎖を切らない
4. 統合は「共存 → 参照 → 統一」の3段階で進める

## Step 1: 共存（現状）

- ALCO OS と既存アプリが同一 Supabase プロジェクトを共有する
- ALCO OS の新テーブルは既存と名前衝突しない（本番DBで確認済み。
  既存: individuals/hunters/staff/attendance/shifts/products/product_movements/
  orders/order_items/customers/customer_prices/price_master/inventory/shipments/
  documents/report_docs/processing_log/cleaning_logs/supplies/freezers/
  data_flags/area_master/org_settings/secretary_pages/obara_lectures。
  このうち **documents が帳票用として既存**のため、ALCO OS の社内Wikiは
  knowledge_docs という名前にしている）
- 既存テーブルへの変更は既存側のマイグレーション（/migrations）でのみ行う

## Step 2: 参照（ダッシュボード統合）— 実施済み（0011）

- 読み取り専用ビュー `v_gibier_*` を追加済み:
  - v_gibier_intake_monthly: 月次捕獲頭数・重量・平均歩留まり（獣種別）
  - v_gibier_inventory: 完成品在庫スナップショット（products.stock_qty が正）
  - v_gibier_sales_monthly: 月次売上（orders。status別）
  - v_gibier_movements_monthly: 月次ムーブメント（完成/持ち出し/店頭販売/廃棄）
- ダッシュボードの「ジビエ基幹」カードは実数値表示に差し替え済み
  （今月の捕獲頭数・獣種内訳・在庫金額・今月売上・累計頭数）
- 残タスク: 音声メモの detected_category = gibier_operation を
  既存テーブルへの参照付きタスクに変換できるようにする

## Step 2.5: 運用統合（勤怠・シフト / 受注）— 実施済み（0013）

参照だけでなく、既存テーブルへの**行の読み書き**を ALCO OS が担う段階。
スキーマは一切変更しない（原則1）。書き込みは必ず domain サービス経由 +
audit_logs 記録。

| 対象 | 正となるテーブル | ALCO OS の役割 |
|---|---|---|
| シフト予定 | 既存 `shifts`（未使用だったものを正式採用） | /hr でパターン割当・上書き・削除（shift-service） |
| 打刻実績 | 既存 `attendance`（punch.html が書く） | 読み取り専用（予実比較・サマリー表示のみ） |
| シフトパターン・希望 | ALCO OS `shift_patterns` / `shift_requests`（0013） | HRMOS流のパターン管理・希望収集 |
| 受注 | 既存 `orders` / `order_items`（order-portal.html が insert） | /orders で status 更新のみ（order-service）。語彙は order-portal と同じ「受注/確認済/発送済/納品完了/キャンセル」で固定 |

注意:
- `shifts` は organization_id を持たない既存スキーマのまま使う。
  ALCO OS 側から organization_id を書き込まないこと
- orders の status に新しい語彙を勝手に足さない（order-portal.html の
  バッジ表示が壊れる）。増やすときは order-portal 側と同時に変更する

追加の共用ポイント（0014〜0018）:
- 帳票センター（/billing）と売上伝票（/ledger）の品目ピッカーは
  既存 `products`（完成品・在庫数）と `price_master`（部位単価3ランク）を
  **読み取り専用**で参照する。顧客の `price_rank` で単価を自動適用
- sales_slips.product_id で products への汎用参照（FKなし）を持つ。
  **在庫数量の増減は既存システム（product_movements）が正。
  ALCO OS から products.stock_qty を書き換えないこと**（二重減算防止）
- 帳票の発行者情報は既存 `org_settings` のキー（org_name / org_postal /
  org_address / org_phone / invoice_number）を共用し、org_bank_info を追加
- スタッフの役割は既存 `staff.role` を共有ボードの宛先として使う（値の更新のみ）
- 飲食店向けボード（/portal/board）は既存 `customers.portal_token` で認証する。
  order-portal.html は変更していない（リンクを置くのは任意・既存側の作業）

## Step 2.6: 捕獲者チャネル（LINE）— 実施済み（0021）

館山ジビエセンターの**既存の**捕獲者向けLINE公式アカウントを ALCO OS に接続する段階。
LINE公式アカウントは新規作成しない（**アカウントID・友だち追加URL・QRコードは変更しない**。
変更するのは LINE Developers の Webhook URL のみ）。

| 対象 | 正となるテーブル | ALCO OS の役割 |
|---|---|---|
| 捕獲者台帳 | 既存 `hunters`（206名） | **読み取りのみ**。行の作成・更新・削除はしない |
| LINEとの紐付け | ALCO OS `hunter_line_links`（0021） | 職員が /line で捕獲者を選んで確定（pending → verified） |
| 受信メッセージ | ALCO OS `line_inbound_messages`（0021） | 受信・分類・返信の記録 |
| 冪等性 | ALCO OS `line_webhook_events`（0021） | webhookEventId の unique で再送を弾く |

`/api/line` は1つのエンドポイントで秘書チャネルと捕獲者チャネルを扱う。

- チャネルの特定は **署名検証**で行う（`destination` は署名検証前には信用できないため、
  登録済み全チャネルのシークレットで順に検証し、成功したチャネルを送信元とする）。
  `destination` は検証後の設定ミス検知にのみ使う
- 秘書チャネル: 従来どおり GAS秘書へ転送し、受信箱へメモ化する（**挙動を変えない**）。
  GASが返信を担うため ALCO OS は返信しない（replyToken は1回のみ有効）
- 捕獲者チャネル: GASへ**転送しない**。ALCO OS が受信・分類・返信を担当する
- 自動返信は定型文のみ（受領のお知らせ・お名前の確認）。
  受入の可否や日時を自動で約束しない。返信文は職員が /line で読んでから送る
- AIは `generated_drafts` にしか書かない。タスク化は /drafts の承認後
- **`individuals`（個体）へ書き込むのは、職員が /gibier/reports で捕獲報告を
  承認したときだけ**（`capture-report-service.approveCaptureReport()`）。
  webhook・AIからは絶対に書き込まない。作るのは既存と同じ「搬入待ち」の仮登録で、
  個体番号の採番・詳細入力は従来どおり現場アプリ（capture-form.html）で行う

注意:
- 捕獲者は捕獲場所・わなの位置を書いてくることがある。これは docs/10 の
  sensitive 相当。`line_inbound_messages` には原座標を保存せず `has_location`
  フラグのみ持つ。地図・座標を画面や書類に出さないこと
- 環境変数は `LINE_HUNTER_CHANNEL_SECRET` / `LINE_HUNTER_CHANNEL_ACCESS_TOKEN` の2つ。
  秘書チャネルは `LINE_SECRETARY_*`（未設定なら既存 `LINE_CHANNEL_*` を使う）
- **`LINE_*_CHANNEL_ID`（Bot User ID / destination）は不要**（0023）。
  チャネルの特定は署名検証で完結しており、DBに保存する識別子は
  安定ラベル `channel:hunter` / `channel:secretary`。
  destination は初回受信時に `line_channel_registry` へ自動記録され、
  `/line` の「つながっているLINE」で確認できる。
  設定した場合は整合性チェック（設定ミスの検知）にだけ使う

### 捕獲報告の定型文と捕獲票のセルフDL（フェーズ3 / 0027）

往復を減らすため、開始メッセージで**型（ラベル：値）**を出し、1回の送信で必要項目を埋められるようにした。

- パーサは `domain/hunters/capture-form-parser.ts`。**純関数・AI不使用**。
  全角/半角コロン・空白・改行・ラベルの言い換え・日付3表記
  （令和8年7月1日 / 2026-07-01 / 7/1）を吸収する
- **型の利用は任意**。ラベルが1つも取れなければ従来どおりAI分類へ回し、
  体重サブフローで1つずつ聞く（案内文にも「1つずつ聞くこともできます」と明記）
- 必須最小セット: 獣種 / 捕獲方法 / 場所 / 捕獲日 / 性別 / 体重+測り方 / 止め刺し。
  **箱罠のときだけ わな番号 も必須**。体長・餌・わな設置日・幼獣は任意
- 捕獲日が空欄なら**送信日を自動採用**
- 不足はまとめて1通で聞き、選べる項目はクイックリプライで1タップ
- 写真は **尻尾切除前・切除後の2枚**（全体写真は廃止。種別 `whole` は後方互換で残す）
- **捕獲者向けの不足判定は「枚数」で行う**（2枚あれば足りている扱い）。
  種別（tail_before / tail_after）の仕分けは職員の作業なので、
  届いているのに捕獲者へ催促しない（2026-07-27 の本番テストで発覚した不具合）
- **不足判定は必ず `capture_reports` の保存済みの値とマージして行う**。
  直近のメッセージだけで判定すると、そろっている報告に文章が届いたときに
  体重の質問を最初からやり直してしまう。そろっていれば補足・雑談として扱い、
  サブフローを再開しない。体重が記録済みなら3択を押し直しても数値を聞き直さない
- 会話状態が切れたあとに写真・位置情報が届いた場合は、**直近24時間の未処理レポートに足す**
  （毎回新しい報告を作らない）。新しい報告が始まるのは「捕獲報告」を押したときだけ

そろった時点で共有リンクを発行し、捕獲者が自分で捕獲票を開ける。

| 対象 | 実装 |
|---|---|
| 共有リンク | `capture_reports.share_token`（32文字の乱数）+ `share_expires_at`（**30日**） |
| 公開ページ | `/hunter/city-form/[token]`（ログイン不要・middlewareで認証除外・`robots: noindex`） |
| 読み出し | 0027 の `get_capture_form_by_token()`。**捕獲票に必要な列だけ**返す（口座・LINE識別子・AI下書きは返さない） |
| 様式 | 既存 `cityFormPrint` と同じ（獣種チェック・令和表記・地理院タイル＋朱色×印・摘要7項目） |
| 無効化・再発行 | `/gibier/reports` の「リンクを作り直す」「リンクを無効にする」（**必須実装**。承認権限が必要） |

### 市役所提出パック（要望3 / 0024）

提出物は3点。**①②は既存実装をそのまま使い、作り直さない。**

| # | 提出物 | 実装 |
|---|---|---|
| ① | 有害鳥獣捕獲票 | **既存** `capture-form.html?cityform=<label_id>`（`cityFormPrint()`。館山有害鳥獣対策協議会様式） |
| ② | 捕獲場所の図面（朱色×印） | **既存** ①の中に地理院タイル＋✕で印字される |
| ③ | 尻尾切除前後を含む写真台紙 | **新規** `/gibier/reports/[id]/pack`（既存に無いため） |

- ALCO OS は ① へのリンク（`NEXT_PUBLIC_GIBIER_APP_URL` + `?cityform=`）と ③ の台紙を出す
- 写真は `capture_report_photos` に種別つきで複数持つ。種別は**職員が画面で選ぶ**
  （AIに推定させない）。台紙は 全体 → 切る前 → 切った後 の順に並ぶ
- 位置情報は市役所提出という正当な用途。**既存の捕獲票が緯度経度をそのまま印字する流儀に合わせ、
  台紙でもマスキングしない**。ただし「提出以外に使わない」注意書きを紙面に必ず入れる（docs/10）

### リッチメニューと受信の分岐（改修指示書 2026-07-25 / 返信仕様確定 2026-07-26）

対象アカウント: 既存の捕獲者向けLINE公式アカウント（Basic ID `@889alcvb`）。
**アカウントは作り直さない。友だち追加URL・QRコードは変更しない。**

リッチメニューは2×3の6分割。5マスがテキスト送信、1マスが電話（tel: URI）。
電話はLINEアプリが直接発信するため webhook には届かない。

| マス | 送信テキスト | Webhookの動き |
|---|---|---|
| 捕獲報告 | `捕獲報告` | capture_reports を開き「写真を送ってください」と返す。以降の写真・位置・本文を報告の続きとして受ける（line_conversation_states） |
| 搬入連絡 | `搬入連絡` | org_settings の受入可否と受付の案内を返し、担当へのタスクを促す |
| 受入状況 | `受入状況` | **本日の受入件数**を返す（individuals を読み取りのみ）。受入停止のときはその旨も添える |
| 買取状況 | `買取状況` | **当面は「準備中」の案内のみ**（買取額は精肉の歩留まりに連動するため自動配信しない）。問い合わせは職員一覧に残る |
| 使い方 | `使い方` | 短い案内文 + 公開ページ `/guide`（ログイン不要・大きい文字）へのリンク |
| 電話 | （tel: URI） | webhook には届かない |

- キーワードは `domain/hunters/hunter-keywords.ts` が文字列で確実に振り分ける
  （AIより先。現場が止まらないことを優先）。旧実装の「搬入します」
  「現場引取を相談します」「受入方法」も後方互換で受ける
- 写真（image）: Content API → Storage バケット `alco-os` → `files` 台帳 →
  `capture_reports.photo_file_id`
- 位置情報（location）: 原座標を `capture_reports.capture_lat/lng` に保存。
  **表示・出力は必ず geo-masking を通す**（docs/10）
- **どの受信にも必ず即時返信する**（「受け付けました。担当が確認します」）。
  送りっぱなしにしない
- 捕獲報告の承認（/gibier/reports）でのみ `individuals` に仮登録を作る。
  形式は既存の捕獲者フォーム（capture-form.html?hunter=）と同じ
  （`label_id='仮-xxx'` / `serial_number=null` / `intake_status='搬入待ち'`）。
  スタッフが `capture-form.html?receive=` で個体番号を付けると null に戻る既存運用に乗る

## Step 3: 統一（権限・データモデル）

- 既存テーブルに organization_id を追加（default で単一組織を埋める）
- allow_all ポリシーを段階的に `alco_add_member_policy` 相当へ移行
  （既存静的アプリが anon キーで動いている間は互換ポリシーを併存させる）
- 既存アプリの画面を ALCO OS の /gibier 配下へ段階移行
  （現場スタッフの習熟を優先し、機能単位で少しずつ）

## 注意

- 既存アプリは PWA としてルートから配信されている。
  リポジトリのルート構成を変えるとサービスワーカー（sw.js）や
  manifest.json が壊れる可能性があるため、alco-os/ ディレクトリ内で完結させること。
- 既存の staff / attendance を HR モジュールで置き換えない。
  データの正はあくまで既存テーブル側（shifts / attendance）に置き、
  ALCO OS はその上の管理UI（/hr, /orders）と SOP・チェックリストを担う。
