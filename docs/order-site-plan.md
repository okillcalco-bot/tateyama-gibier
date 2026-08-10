# 注文サイト 実装計画書（改訂版 v2.1）

> **v2.1（2026-08-09）: 施主決定を反映。§0 に確定事項を追記。フェーズ1 実装開始。**

- 対象: `okillcalco-bot/tateyama-gibier`（ルート直下の静的HTML + Supabase 直結PWA群）
- 改訂日: 2026-08-09 ／ 初版: 2026-08-09（v1）
- 改訂理由: 施主要望（スマホ前提の再設計・請求書からの購入実績取込・顧客別価格の検証）とレビュー指摘の反映
- **本計画の提出時点で、本番データへの破壊的変更は行っていません。** DB変更はすべて `/migrations` への追加SQLのみです。

---

# §0 確定事項（施主決定 2026-08-09・v2.1）

1. **画面**: 既存ポータルの部分修正ではなく、スマホ専用 `order.html` を新設。
   `order-portal.html` は削除・置換せず並行運用。移行方法・互換性・ロールバックを用意し、
   **新画面公開時に旧画面が旧価格ロジックで注文できない状態にする**（旧画面の注文送信を
   RPC経由に差し替えるか、注文ボタンを新画面への誘導に置き換える。フェーズ3で実施）。
   sw.js は `manual-app.html` のみが登録しており、HTMLはネットワーク優先のため
   **`order.html` 新設に sw.js の変更は不要**（確認済み）。
2. **Drive請求書**: 経路A（Drive直接）を希望。承認リクエスト発行済み・承認待ち。経路Bも維持。
   **フォルダ内の既存画像を無差別に請求書として処理しない** — 取込はファイル単位の選択、
   または対象期間・ファイル種別の確認を経てから実行する。OCR結果はステージング必須、
   重量・単価・金額・顧客名の読取信頼度が低いものは自動確定禁止。
3. **商品の初期構成**（確定・§5-4 のシード）:

   | 在庫上の名称 | ポータル商品名 | 初期公開 |
   |---|---|---|
   | ミンチ用（並） | ミンチ原料用 | 非公開 |
   | ミンチ肉（粗挽き）（上） | 猪粗挽きミンチ | **公開** |
   | ペットフード用（あり） | 猪ペットフード・骨あり | 非公開 |
   | ペットフード用（なし） | 猪ペットフード・骨なし | 非公開 |
   | 味肉用 | 内部用途 | 非公開 |
   | チチカブ | 希少部位 | 非公開 |
   | キョン | キョン商品 | 非公開 |

   「ミンチ用」と「ミンチ肉（粗挽き）」は**同一商品にまとめない**。ペットフードは骨あり／なしで分ける。
   非公開商品も商品マスタには登録し、在庫の削除・自動改名はしない。
   商品単位で 公開／注文可否／顧客区分別公開／説明／等級／最小注文量／注文単位／価格／対象部位 を独立設定。
4. **顧客別価格**: `customers.portal_enabled` を追加、**既定 false**。一括無効化のような挙動変更を
   伴わないことを確認してから適用（現時点でこの列を読む処理は無く、案内済み顧客も存在しない。
   ロールバックは列drop）。価格の表示と注文確定は**同一のサーバ側価格解決関数**を使う。
   再注文の過去単価フォールバックは**廃止**。
5. **試験運用**: anon で顧客情報が読める間は実顧客でのネット試験は**不可**（3〜5社限定でも不可）。
   試験はモック環境／匿名化ステージング／RPC化＋RLS引き締め完了後のいずれかに限定。
   センター側 Supabase Auth も実顧客試験のブロッカー。本番案内の前提条件は §6 のとおり全項目完了。
6. **引当**: 重量は**グラム単位の整数**に正規化してDPに渡す（numericのままキーにしない）。
   優先順位: ①希望重量以上 ②超過最小 ③同程度なら古い在庫 ④使用パック数が少ない。
   `FOR UPDATE SKIP LOCKED` で**先にロックした集合に対してだけ**組み合わせを確定し、
   更新件数が想定と違えば全体ロールバック。詳細は §5-4。
7. **名寄せ**: 電話一致の確度0.95は補助値。同一電話に複数顧客／本店・支店／法人名と店舗名の相違／
   請求先と納品先の相違／名称のみ一致／電話なし／住所矛盾／同一名称の別事業者は**確度に関係なく人が確認**。
   商品の「価格差2割」は補助条件であり、それだけで別商品と確定しない。全件未判定から人が確定。
8. **再発防止テスト**（§8 に追加済み）: 価格表示とカート単価の一致／RPC確定単価と画面の一致／
   単価改ざんの不採用／過去単価フォールバックの不存在／消えた商品・販売停止・在庫切れの再注文不可／
   お気に入りが再集計で消えない／再取込で購入回数が増えない／390pxで44px未満0件／
   商品一覧と納品情報の分離／キーボード表示時の下部バー。

---

# 第1部 事前調査の報告（要望 §2）

## 1-1. お気に入り・マイリスト・再注文の実装状況

`order-portal.html` に実装済み。テーブルは `customer_saved_items`。

```
customer_saved_items: id / customer_id / kind / product_id / species / part_name / grade / sort_order / created_at
```

| 機能 | 関数 | 状態 |
|---|---|---|
| ☆お気に入り | `toggleSaved('favorite', …)` | `kind='favorite'` で登録／解除 |
| ＋いつもの | `toggleSaved('usual', …)` | `kind='usual'`。**手動登録のみ。自動抽出は無し** |
| 前回注文の再注文 | `reorderLast()` | 直近1件をカートへ |
| 履歴からの再注文 | `reorderFromHistory(orderId)` | 履歴の任意の注文をカートへ |

**本番データ: `customer_saved_items` は 0 行**（誰も使っていない）。移行対象の既存マイリストは実質ありませんが、
設計上は「あれば保持・移行」を満たします（§4-3）。

**発見した不具合（重要）**

1. `reorderLast()` / `reorderFromHistory()` は、商品がカタログから消えていると
   `it.unit_price`（**過去の単価**）にフォールバックしてカートに入る。販売停止品・在庫切れの判定も無い。
   → 要望 §8「過去注文をそのまま複製しない」に真っ向から反する既存挙動。
2. 「いつもの」と「お気に入り」が `customer_saved_items` の `kind` 違いだけで、
   自動抽出と手動登録が同じ表に同居する設計になっている（要望 §4 で分離が指示された箇所）。

## 1-2. `customers` と請求書を照合するために使える項目

`customers` の全列のうち、名寄せに使えるもの:

| 列 | 充足率（718件中） | 名寄せでの位置づけ |
|---|---|---|
| `name` | 718 / 718 | 主キー的だが**同名が4組8件**あり単独では確定不可 |
| `phone` | **718 / 718** | 最強。表記ゆれ（ハイフン有無）を正規化すれば実質一意 |
| `address` | 718 / 718（〒込みの1本文字列） | 郵便番号を切り出せる |
| `code` | 718 / 718（C0011 形式） | 請求書に印字されていれば最強 |
| `kana` | 一部 | 補助 |
| `contact_name` | 一部 | 法人名が入っている例あり（例: `株式会社食環境衛生研究所`） |
| `company1` / `company2` | ほぼ空 | 将来用 |
| `email` | **1 / 718** | 使えない |

→ **電話番号の正規化一致を第一キー、郵便番号＋名称の類似を第二キー**とするのが妥当（§5-2）。

## 1-3. 現在の顧客別価格の管理方法

2系統が併存しており、**片方が注文単価に反映されていません**。

| 仕組み | テーブル／列 | 実データ | 注文単価に効くか |
|---|---|---|---|
| 価格ランク | `customers.price_rank` → `price_master.price_<rank>` | 718件**すべて `standard`** | ○（`getPrice()`） |
| 顧客別単価 | `customer_prices(customer_id, species, part_name, unit_price)` | **0 行** | **×** |

**確認された不具合（施主のご指摘どおり）**
`order-portal.html` の価格表表示 `loadPriceTable()` は `customer_prices` を優先して表示しますが、
カート投入時の単価 `getPrice()` は **`price_master` しか見ていません**。
`customer_prices` に値を入れると、**画面に出る価格表と実際の注文単価が食い違います**。

現在は `customer_prices` が0行のため実害は出ていませんが、構造的な欠陥です。

## 1-4. `price_rank` 以外の個別価格の存在

`customer_prices` が該当しますが **0 行**。有効期間の概念もありません（`valid_from` / `valid_until` 無し）。
要望 §7 の `customer_product_prices` 相当は**新規に作る必要があります**（§5-3）。

## 1-5. 過去注文・請求書から再注文用データを作れるか

**DB内の実績はほぼ空です。**

| 元データ | 件数 | 期間 |
|---|---|---|
| `orders` | 11件 / 3社 | 2026-03-23 〜 2026-08-07 |
| `order_items` | 32行（うち26行が `inventory_id` 有） | 同上 |
| `documents`（発行済み書類） | **納品書1件のみ**、請求書0件 | 2026-08-05 |
| `payments` | — | — |

→ **「いつもの商品」は事実上100%、Driveの請求書から作ることになります。**
DB内の11件は補助的に併用します（§5-5）。

## 1-6. 商品名・部位名・等級の表記揺れ

カタログ（`price_master` の `grade='上'` かつ `barcode_num` 有＝ポータルが出している商品）と、
実在庫（`inventory` の `status='在庫'`）を突き合わせた結果:

| 判定 | 件数 | 中身 |
|---|---|---|
| 一致 | 8 | スネ / ネック / バラ / ヒレ / ミンチ用 / ロース / 肩ロース / シカ ロース |
| **在庫にあるがカタログに無い** | 8 | 在庫`カタ`↔カタログ`カタ（ウデ）` ／ 在庫`ミンチ肉（粗挽き）`↔カタログ`ミンチ肉` ／ 在庫`ペットフード用（あり）`・`ペットフード用（なし）`↔カタログ`ペットフード用` ／ 在庫`味肉用`・`チチカブ`（該当なし）／ 在庫`シカ モモ（ウチ）`↔カタログ`シカ モモ` ／ 在庫`キョン ロース`（キョンがカタログに無い） |
| カタログにあるが在庫なし | 30 | 内臓各種 / 中型獣ほぼ全部 |

**在庫の約6割（kgベース）がカタログに無い名前**です。文字列一致で在庫とカタログを結ぶ設計は成立しません。

**等級のねじれ**: 在庫111点のうち **87点が `並`**。しかしポータルは `grade='上'` の価格しか出していません。
上の値段で受注して並を出荷する状態になりえます。

## 1-7. 請求書取込に利用できる既存処理の有無

**ありません。** `order-admin.html` の「請求書作成」は**発行**（HTML→印刷）専用で、取込機能はありません。
`invoices` / `invoice_items` テーブルも存在しません。

**この環境で使える道具**

| 用途 | 可否 |
|---|---|
| PDF テキスト抽出 | ○ `pdftotext`（poppler）／ `pypdf` |
| PDF → 画像 | ○ `pdftoppm` |
| Excel | ○ `openpyxl` |
| OCR（tesseract） | **×** 未インストール |
| 画像の読み取り | ○ **アシスタントの画像認識で読む**（放射能検査の手書き速報19枚を読んだ実績あり） |
| Drive への直接アクセス | **× 現在ブロック**（MCPが承認待ち。§5-1 に代替手順） |

## 1-8. スマホ幅 390px での現行画面の問題点（実測）

Playwright（390×844 / iPhone 12〜14 相当）で `order-portal.html` を計測しました。

| 項目 | 実測 | 評価 |
|---|---|---|
| ログイン後の総ページ高 | **4457px = 5.3画面ぶん** | 縦に長すぎる |
| 商品カード | 324×**158px**（1行1商品） | 1画面に5商品しか入らない |
| 最後の商品までのスクロール | **3466px = 4.1画面ぶん** | 18商品で4画面。カタログ全48商品なら10画面超 |
| 下部固定バー（カート／確認） | **なし** | カート確認のたびに最上部まで戻る |
| タップ領域 44px 未満 | **73件** | ☆ 30×25px、＋いつもの 78×25px、数量 80×40px、カートに追加 106×40px |
| 納品日・時間帯・備考 | **商品一覧と同一画面** | 商品を選ぶだけの画面に配送入力が混在 |
| 横スクロール | なし | ○（唯一の合格点） |
| 商品説明 | 常時非表示（そもそも表示欄が無い） | 要件を満たすには追加が必要 |

**結論: 既存画面への機能追加では要望を満たせません。スマホ専用の注文導線を新設します（§4）。**

---

# 第2部 改訂版 実装計画

## 2-1. 方針の変更点（v1 → v2）

| 論点 | v1 | **v2** |
|---|---|---|
| 画面 | 既存ポータルに◎△×を足す | **スマホ専用画面を新設**（`order-portal.html` は残して段階移行） |
| いつもの商品 | 手動登録のまま | **請求書実績からの自動抽出**。お気に入りとテーブルを分離 |
| 顧客別価格 | `price_rank` のみ | **`customer_product_prices` を新設**し4段階の優先順位。単価はRPCで決定 |
| 再注文 | 過去明細をコピー | **現在条件で全項目を再計算**。カート作成まで |
| 引当 | FIFO＋1.25倍上限 | **超過最小の組み合わせ探索**。パック単位・分割禁止 |
| セキュリティ | 後工程 | **P0（試験運用前に必須）** |
| 請求書 | 対象外 | **ステージング経由の取込**を新規に構築 |

## 2-2. 成果物と対応表（要望 §13）

| # | 成果物 | 本書の該当箇所 |
|---|---|---|
| 1 | 改訂版実装計画 | 本書全体 |
| 2 | 390px 画面構成案 | §4 |
| 3 | テーブル・RPC設計 | §5 |
| 4 | 請求書取込フロー | §5-1 |
| 5 | 顧客・商品の名寄せルール | §5-2 |
| 6 | 顧客別価格の決定ルール | §5-3 |
| 7 | いつもの商品の抽出ルール | §5-5 |
| 8 | データ移行・ロールバック計画 | §7 |
| 9 | セキュリティ対応順序 | §6 |
| 10 | テスト計画 | §8 |
| 11 | 未決事項・施主判断が必要な点 | §9 |

---

## §3 全体像

```
Drive（請求書 PDF/Excel/画像）
   │  ①取込（ローカル経由・ステージング）
   ▼
invoice_imports → invoice_documents → invoice_lines     …未処理/抽出済/要確認/確認済/取込済
   │  ②名寄せ（顧客・商品）  ─ 確度を記録し、曖昧なものは人が確認
   ▼
customer_purchase_facts（確定した購入実績）
   │  ③集計
   ├─► customer_usual_items（いつもの商品・自動）
   └─► price_variance_report（過去実売単価 vs 現在ポータル単価）
                                    │ 人が確認して
                                    ▼
                          customer_product_prices（顧客別価格・手動確定）

portal_products ─┬─ portal_product_parts ── inventory（在庫の実体）
                 ├─ portal_product_prices（ランク別）
                 └─ customer_product_prices（顧客別・最優先）

お客様（スマホ） ── portal_sessions ── RPC のみ ──► orders / order_items / inventory_allocations
```

---

## §4 スマホ注文画面（390px・要望 §3）

新規ファイル **`order.html`**（`order-portal.html` は当面残し、案内のリンク先を段階的に切り替え）。

### 4-1. 3画面で完結

```
[画面1 選ぶ]  ──→  [画面2 確認]  ──→  [画面3 完了]
```

商品一覧では **商品の選択以外を入力させません**。納品日・時間帯・配送先・備考はすべて画面2です。

### 4-2. 画面1（選ぶ）の構成

```
┌────────────────────────────── 390px
│ 狩野屋様                        [ログアウト]   ← 44px
├──────────────────────────────
│ ⭐ いつもの商品                          ← 最大5件・自動抽出
│ ┌──────────────────────────┐
│ │ 猪ミンチ 粗挽き        ◎  ¥3,200/kg │  ← 1行56px
│ │ いつも 3.0kg   [−] 3.0 [+]  [追加] ☆│
│ └──────────────────────────┘
│ … （最大5行 = 約280px）
├──────────────────────────────
│ 🔁 前回の注文  2026-07-28
│   猪ミンチ 3.0kg / ロース 1.5kg
│   [ 同じ内容をカートに入れる ]           ← 確定はしない
│   ⚠ ロースは現在ご用意できません
├──────────────────────────────
│ ★ お気に入り（本人が☆を付けたもの）
├──────────────────────────────
│ 🐗 全商品   [イノシシ][シカ][その他]     ← 種の切替
│   （同じ1行56pxの行が並ぶ）
├──────────────────────────────
│ ▶ 在庫切れの商品（3件）                  ← 既定で折りたたみ
└──────────────────────────────
┃ 3点 / 概算 ¥12,400   [ 確認へ ]  ┃ ← 下部固定・高さ64px
```

### 4-3. 商品1行の仕様（縦長カードをやめる）

**動く試作を `docs/mockups/order-mobile.html` に置き、390×844 で実測しました**
（画面キャプチャ: `docs/mockups/order-mobile-390px.png`）。

| 指標 | 現行 `order-portal.html` | **試作 `order-mobile.html`** |
|---|---|---|
| 1商品あたりの高さ | 158px | **87px**（2段組・−／＋を44pxにした上で） |
| 同じ内容の総ページ高 | 4457px（5.3画面） | **1345px（1.6画面）** |
| タップ領域 44px 未満 | **73件** | **0件** |
| 下部固定バー | なし | あり（3点／概算／確認へ） |
| 横スクロール | なし | なし |

| 要素 | 仕様 |
|---|---|
| 行の高さ | **87px**（現行158pxの約55%。1画面に約9商品） |
| 1段目 | 商品名（省略記号）＋ 在庫記号 ＋ 単価 |
| 2段目 | いつもの注文量 ＋ [− 数量 ＋] ＋ [追加] ＋ ☆ |
| 商品名 | 1行・省略記号。タップで説明を展開（既定は非表示） |
| 在庫記号 | ◎／△／× のみ。**重量は出さない** |
| 単価 | **その顧客に適用される単価**（`customer_product_prices` → ランク → 標準の順で解決済みの値） |
| いつもの注文量 | 「いつも3.0kg」。数量の初期値にも使う |
| − / ＋ | **各44×44px**。`step_kg` 刻み、`min_order_kg` 下限 |
| 追加 | 56×44px。**1タップでカート投入**（数量が既定のままなら計1タップ） |
| ☆ | 44×44px。お気に入りの登録／解除 |
| × の行 | 数量と追加を無効化し、下部の折りたたみへ移す |

### 4-4. 画面2（確認）

- 明細（商品名・希望重量・単価・小計）と **合計は「概算」と明示**
- 納品希望日 / 時間帯 / 配送先 / 備考
- **現物重量の注記を必ず表示**:
  > ジビエは現物パック単位のため、ご希望量を下回らない範囲で重量が前後します。請求額は実際に確保した重量で確定します。
- **前回と価格が違う明細は差分を表示**（`前回 ¥3,000 → 今回 ¥3,200`）。過去価格は選べません
- 注文できない明細は赤字で「現在は注文できません／代替候補をご確認ください」。**勝手に別商品へ置き換えません**

### 4-5. 実装上の約束

- タップ領域は全て **44×44px 以上**
- 下部固定バーは `position:fixed; bottom:0` ＋ `env(safe-area-inset-bottom)`
- 数量入力はキーボードを出さない（−／＋のみ。直接入力は長押しで開くダイアログ）
- 390px を基準に Playwright で毎回検証（§8）

---

## §5 テーブル・RPC 設計

すべて `/migrations` への**追加SQL**です。既存テーブルの列削除・改名は行いません。

### 5-1. 請求書取込（要望 §5）

#### テーブル

```sql
-- 取込の単位（1ファイル＝1行）
create table invoice_imports (
  id            uuid primary key default gen_random_uuid(),
  source        text not null,              -- 'drive' | 'local'
  source_file_id text,                      -- DriveのファイルID
  file_name     text not null,
  mime_type     text,
  content_hash  text not null,              -- ファイル全体のSHA-256
  page_count    int,
  status        text not null default '未処理',
    -- 未処理 / 抽出済 / 顧客未照合 / 商品未照合 / 要確認 / 確認済 / 取込済 / 除外
  error_message text,
  imported_by   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (content_hash),                    -- 同一ファイルの再取込を防ぐ
  unique (source, source_file_id)
);

-- 1ファイルに複数枚の請求書が入りうる
create table invoice_documents (
  id             uuid primary key default gen_random_uuid(),
  import_id      uuid not null references invoice_imports(id) on delete cascade,
  page_from      int, page_to int,          -- 元資料の該当ページ（追跡用）
  invoice_number text,
  invoice_date   date,
  delivery_date  date,
  raw_customer_name text,                   -- 請求書に書かれたまま
  raw_addressee  text,                      -- 宛名
  raw_address    text,
  raw_postal     text,
  raw_phone      text,
  total_amount   numeric,
  note           text,
  customer_id    uuid references customers(id),   -- 名寄せ結果
  match_confidence numeric,                 -- 0.00〜1.00
  match_method   text,                      -- phone / postal+name / code / manual
  match_status   text not null default '未照合',  -- 未照合 / 候補あり / 確定 / 対象外
  matched_by     text, matched_at timestamptz,
  created_at     timestamptz not null default now(),
  unique (import_id, page_from, invoice_number)
);

create table invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references invoice_documents(id) on delete cascade,
  line_no       int not null,
  raw_item_name text not null,              -- 請求書の品名そのまま
  raw_species   text, raw_part text, raw_grade text,
  weight_kg     numeric, unit_price numeric, amount numeric,
  note          text,
  source_ref    text,                       -- 'p.2 表1 行5' など元資料の該当箇所
  confidence    numeric,                    -- 読み取りの確からしさ
  product_id    uuid references portal_products(id),
  match_confidence numeric, match_method text,
  match_status  text not null default '未照合',
  created_at    timestamptz not null default now(),
  unique (document_id, line_no)
);

-- 確認済みの購入実績（ここから「いつもの」と価格比較を作る）
create table customer_purchase_facts (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references customers(id),
  product_id    uuid not null references portal_products(id),
  purchased_on  date not null,
  weight_kg     numeric not null,
  unit_price    numeric,
  amount        numeric,
  source_kind   text not null,              -- 'invoice' | 'order'
  source_id     uuid not null,              -- invoice_lines.id または order_items.id
  created_at    timestamptz not null default now(),
  unique (source_kind, source_id)           -- 冪等性
);
```

#### 状態遷移

```
未処理 ──抽出──► 抽出済 ──名寄せ──┬─► 顧客未照合 ─┐
                                  ├─► 商品未照合 ─┼─► 要確認 ──人が確認──► 確認済 ──► 取込済
                                  └─► （両方確定）─┘                              └──► 除外
```

**OCR・表抽出の結果を直接 `customer_purchase_facts` へ入れません。** 必ず `invoice_lines` を経由し、
`確認済` になったものだけを `取込済` に進めます。

#### 冪等性

- ファイル: `content_hash` の一意制約（同じファイルを2度読んでも2行にならない）
- 請求書: `(import_id, page_from, invoice_number)` の一意制約
- 実績: `(source_kind, source_id)` の一意制約 ← **再取込しても購入回数が二重に増えません**

#### Drive からの取込手順（**現在Driveがブロックされているため2経路を用意**）

現状: Drive MCP が承認待ち（`MCP tool call requires approval`）でフォルダを開けません。
承認いただければ経路Aが使えます。使えないままでも経路Bで進みます。

**経路A（Drive直結）**: フォルダ `1HrsJYXbLof6OtZ_sUYFN0gXweYMcWgao` を列挙 →
`download_file_content` で取得 → 下記の抽出処理へ。

**経路B（ローカル取込・Driveが使えない場合）**
1. 取込ディレクトリを **`import/invoices/`**（リポジトリには含めず `.gitignore`）に定める
2. 施主がDriveから一括ダウンロードして配置。または `import/invoices/` に直接置く
3. `scripts/import-invoices.mjs` を実行

```
node scripts/import-invoices.mjs --dir import/invoices --dry-run   # 抽出だけ
node scripts/import-invoices.mjs --dir import/invoices --push      # ステージングへ投入
```

**形式ごとの抽出**

| 形式 | 方法 | 備考 |
|---|---|---|
| Excel (.xlsx) | `openpyxl` | 表がそのまま取れる。最も確実 |
| テキストPDF | `pdftotext -layout` | 罫線なしのレイアウト保持テキストから列を推定 |
| 画像PDF・画像 | `pdftoppm` でPNG化 → **画像認識で読み取り** → JSON | tesseract が無いため。1枚ずつ確認できるよう `source_ref` にページを残す |

**実ファイルが揃う前でも検証できるよう、`import/invoices/_samples/` にモック請求書（Excel 3種・
テキストPDF 2種・画像PDF 1種）を同梱**し、テストはモックで回します。

### 5-2. 名寄せルール（要望 §6）

#### 顧客の名寄せ

**部分一致だけで自動確定しません。** 下記のスコアで候補を出し、確度を記録します。

| 判定 | 条件 | 確度 | 扱い |
|---|---|---|---|
| 確定 | `code` が一致 | 1.00 | 自動確定 |
| 確定 | 正規化電話が完全一致（数字のみ比較）かつ 候補が1件 | 0.95 | 自動確定 |
| 候補 | 正規化電話が一致するが候補が複数 | 0.70 | **人が確認** |
| 候補 | 郵便番号一致 ＋ 名称の類似度 ≥ 0.8 | 0.75 | **人が確認** |
| 候補 | 名称完全一致のみ（電話・住所の裏付け無し） | 0.50 | **人が確認**（同名4組あり） |
| 候補 | 名称の部分一致のみ | 0.30 | **人が確認** |
| 未照合 | 上記いずれも無し | 0.00 | 確認一覧へ |

- 名称の正規化: 全角→半角、スペース除去、`株式会社`↔`(株)`↔`㈱`、`有限会社`↔`(有)`、
  `合同会社`↔`(同)` を吸収。類似度は正規化後の文字bigram Jaccard
- 電話の正規化: 数字以外を除去。先頭 `+81` → `0`
- 既存の注文履歴・請求履歴がある顧客はスコアに +0.1（同名の判別材料）
- **確度 0.95 未満はすべて確認一覧に出し、人が確定するまで `customer_purchase_facts` に入りません**

#### 商品の名寄せ

**名称が似ているだけで統合しません。** 対応表を明示的に持ちます。

```sql
create table product_name_aliases (
  id          uuid primary key default gen_random_uuid(),
  raw_name    text not null,               -- 請求書や在庫に出てくる表記
  raw_species text, raw_grade text,
  product_id  uuid references portal_products(id),
  decision    text not null default '未判定', -- 未判定 / 対応づけ / 別商品 / 対象外
  decided_by  text, decided_at timestamptz,
  note        text,
  unique (raw_name, coalesce(raw_species,''), coalesce(raw_grade,''))
);
```

- 初期は**全件 `未判定`**。センター側の「商品の照合候補」画面で1件ずつ決めます
- 機械は**候補を提示するだけ**。`カタ` / `肩` / `ウデ` / `カタ（ウデ）` のような組は候補に出しますが自動確定しません
- **価格帯が2割以上違う組み合わせは候補から除外**し、`別商品` の既定にします
  （`ペットフード用（骨あり）` と `（骨なし）` のように商品性・価格が異なるものを守るため）
- `未判定` の行がある請求書は `商品未照合` のまま `取込済` に進めません

### 5-3. 顧客別価格の決定ルール（要望 §7）

```sql
create table customer_product_prices (
  customer_id uuid not null references customers(id) on delete cascade,
  product_id  uuid not null references portal_products(id) on delete cascade,
  unit_price  int  not null check (unit_price >= 0),
  valid_from  date,
  valid_until date,
  note        text,
  updated_by  text,
  updated_at  timestamptz not null default now(),
  primary key (customer_id, product_id)
);
```

既存 `customer_prices`（species/part_name ベース・0行）は**残しますが使いません**。
`portal_products` 基準の上表へ寄せます（`comment on table` で非推奨を明記）。

**決定順位（DB側の関数 `resolve_unit_price(p_customer_id, p_product_id, p_on date)` で一元化）**

| 順 | 出典 | `price_source` |
|---|---|---|
| 1 | `customer_product_prices`（`p_on` が有効期間内） | `customer_override` |
| 2 | `portal_product_prices`（顧客の `price_rank`） | `price_rank` |
| 3 | `portal_product_prices`（`standard`） | `standard` |
| 4 | 該当なし | **注文不可**（明細ごとにエラー） |

**注文RPCはクライアントから来た単価を一切見ません。** `resolve_unit_price()` の戻り値だけを使います。

`order_items` に**追加する列**（注文時点のスナップショット）:

```sql
alter table order_items
  add column if not exists product_id_v2   uuid references portal_products(id),
  add column if not exists product_name    text,      -- 表示名のスナップショット
  add column if not exists grade_snapshot  text,
  add column if not exists price_rank_applied text,
  add column if not exists price_source    text,      -- customer_override / price_rank / standard
  add column if not exists requested_kg    numeric,   -- 注文希望重量
  add column if not exists allocated_kg    numeric;   -- 実引当重量
```

既存の `product_id`（`price_master.id` を指していた）とは別列にして、既存データを壊しません。

**価格差比較表**（取込後に出力。§11 の管理画面から閲覧・CSV出力）

| 顧客 | 商品 | 購入回数 | 過去の最新実売単価 | 過去の最頻実売単価 | 現在のポータル単価 | 差額 | 要確認理由 |
|---|---|---|---|---|---|---|---|

要確認理由の例: `差額 ±5%以上` / `過去単価が複数（最頻と最新が不一致）` / `現在価格が未設定` / `個別価格の期限切れ`

`customers` に `portal_enabled boolean default false` を追加し、**価格差が解消するまで
その顧客のポータル案内を有効化しない**運用を可能にします（§9-4 で判断を仰ぎます）。

### 5-4. 商品マスタ・在庫・引当

```sql
create table portal_products (
  id uuid primary key default gen_random_uuid(),
  species text not null, display_name text not null, description text,
  sort_order int not null default 100,
  min_order_kg numeric not null default 0.5,
  step_kg numeric not null default 0.5,
  low_kg numeric not null default 3.0,          -- これ未満は △
  is_active boolean not null default true,      -- 販売停止はここ
  is_reorderable boolean not null default true, -- 一般商品として再注文可か
  created_at timestamptz default now()
);
create table portal_product_parts (            -- 1商品 = 在庫の部位×等級（複数可）
  product_id uuid not null references portal_products(id) on delete cascade,
  part_name text not null, grade text,          -- grade null = 等級を問わない
  primary key (product_id, part_name, coalesce(grade,''))
);
create table portal_product_prices (
  product_id uuid not null references portal_products(id) on delete cascade,
  price_rank text not null, unit_price int not null check (unit_price >= 0),
  primary key (product_id, price_rank)
);
create table inventory_allocations (
  id uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references order_items(id) on delete cascade,
  inventory_id  uuid not null references inventory(id),
  weight_kg     numeric not null,
  created_at    timestamptz not null default now()
);
create unique index inventory_allocations_one_per_pack on inventory_allocations(inventory_id);
```

#### 在庫記号（重量は返さない）

`portal_stock_public(product_id, mark, min_order_kg, step_kg)` を**関数**で返します。
`avail_kg` はサーバ内で使うだけで、**APIレスポンスに含めません**（要望「重量は出さない」の担保）。

| 記号 | 条件 |
|---|---|
| ◎ | `avail_kg >= low_kg` |
| △ | `min_order_kg <= avail_kg < low_kg` |
| × | `avail_kg < min_order_kg` |

#### 引当アルゴリズム（要望 §9・**FIFO＋1.25倍をやめる**）

**未開封パック単位。1在庫点は1注文にのみ。`weight_kg` は元在庫の重量と一致（部分減算しない）。**

```
目的: 合計 >= 希望量 を満たす部分集合のうち
  第1優先: 超過量 (合計 − 希望量) が最小
  第2優先: 使用パック数が少ない
  第3優先: 古い在庫（processed_at 昇順）を多く含む
```

実装:
1. `select … from inventory where 部位一致 and status='在庫' and deleted_at is null
    order by processed_at asc **for update skip locked**` で候補を確保（同時注文の二重引当を防止）
2. 重量を10g単位の整数に丸め、**部分和のDP**で「希望量以上で最小の合計」を求める
   （候補25点以下 かつ 希望量30kg以下のとき。DP表は 25×3000 程度で実用範囲）
3. 候補がそれを超える場合は**貪欲＋局所改善**にフォールバック
   （降順に積んで達したら、最後の1点をより小さい点に差し替えて超過を詰める）。
   フォールバックしたことは `orders.notes` に記録
4. 合計が希望量に届かなければ **注文全体をロールバック**し、`不足` を返す（部分受注しない）
5. 取った点を `status='引当済'` に更新、`inventory_allocations` に記録、
   `order_items.allocated_kg` に実重量、`requested_kg` に希望量を保存
6. 金額は `allocated_kg × 確定単価` で計算

**小分けが必要な場合**は元在庫を減算せず、業務アプリ側で**子在庫を作る別処理**（`parent_inventory_id` を使う既存の仕組み）とします。注文RPCからは行いません。

**戻し**: `キャンセル` で `引当済 → 在庫`、`発送済` で `引当済 → 出荷済`。二重に戻らないよう
`inventory_allocations` の存在を条件にします。

### 5-5. 「いつもの商品」の抽出ルール（要望 §4）

**お気に入りとテーブルを完全に分けます。**

```sql
-- 自動抽出（システムが作る。人の★とは別物）
create table customer_usual_items (
  customer_id     uuid not null references customers(id) on delete cascade,
  product_id      uuid not null references portal_products(id) on delete cascade,
  rank            int  not null,             -- 1〜5
  purchase_count  int  not null,
  total_kg        numeric not null,
  avg_order_kg    numeric not null,          -- 「いつもの注文量」の根拠
  usual_qty_kg    numeric not null,          -- 画面の初期値（step_kg に丸めた値）
  last_purchased_on date,
  avg_interval_days numeric,
  reason          text not null,             -- 自動抽出の根拠（人が読める文）
  computed_at     timestamptz not null default now(),
  is_pinned       boolean not null default false,  -- 人が固定したものは自動更新で消さない
  is_hidden       boolean not null default false,  -- 人が非表示にした
  primary key (customer_id, product_id)
);
```

お気に入りは**既存の `customer_saved_items` を `kind='favorite'` 専用として継続利用**します
（0行なので実害はありませんが、`kind='usual'` の行があれば `favorite` へ移し替えて保持 → §7-2）。

**初期候補の条件**

1. 直近1年で **購入2回以上**、または **直近3か月以内に購入**
2. 並び: `購入回数 desc` → `直近購入日 desc` → `累計重量 desc`
3. 顧客ごと **最大5商品**
4. `portal_products.is_reorderable = false`（特殊商品）は除外
5. `is_hidden` は除外、`is_pinned` は無条件で先頭

`usual_qty_kg` = `avg_order_kg` を `step_kg` に丸め、`min_order_kg` を下回らせない。

**再集計しても `customer_saved_items`（お気に入り）は一切触りません。**
自動更新は `customer_usual_items` の `is_pinned = false` の行だけを入れ替えます。

### 5-6. セッションとRPC（要望 §10）

```sql
create table portal_sessions (
  token       text primary key,             -- 32バイト乱数のbase64url
  customer_id uuid not null references customers(id) on delete cascade,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '30 days',
  user_agent  text
);
```

お客様側が呼ぶのは**RPCだけ**にし、テーブルへの直接アクセスを全廃します。

| RPC | 役割 |
|---|---|
| `portal_login(login, password)` | 既存。**トークンを返すよう変更** |
| `portal_logout(token)` | トークン失効 |
| `portal_me(token)` | 顧客情報（パスワードは返さない） |
| `portal_catalog(token)` | いつもの／お気に入り／全商品／在庫切れ。**記号と適用単価のみ。実重量は返さない** |
| `portal_last_order(token)` | 前回注文の内容（再構成前） |
| `portal_rebuild_cart(token, order_id)` | 前回注文を**現在条件で再計算**してカート案を返す（注文しない） |
| `portal_place_order(token, items, delivery…)` | 単価決定＋引当＋注文作成をトランザクションで |
| `portal_my_orders(token)` | 履歴 |
| `portal_toggle_favorite(token, product_id)` | ☆の登録／解除 |
| `portal_change_password(login, old, new)` | 既存 |

---

## §6 セキュリティ対応順序（要望 §10・**P0**）

| # | 内容 | いつ |
|---|---|---|
| 1 | 商品・価格・引当の設計と実装 | 実装フェーズ1 |
| 2 | `portal_sessions` とトークン発行 | フェーズ2 |
| 3 | お客様向け読取・注文RPC | フェーズ2 |
| 4 | お客様側の直接DBアクセス廃止（`order.html` はRPCのみ） | フェーズ2 |
| 5 | **RLS引き締め**（`customers` / `orders` / `order_items` の `anon` 全権ポリシーを削除） | フェーズ2 |
| 6 | スマホ注文UI | フェーズ3 |
| 7 | 限定顧客（3〜5社）による試験運用 | フェーズ4 |
| 8 | センター側 Supabase Auth | フェーズ5 |
| 9 | 本番案内（718件への配布） | フェーズ6 |

### ⚠️ スタッフキー方式は「暫定認証」（2026-08-10 明記）

センター画面のスタッフキー＋HTTPヘッダ方式は、**センター画面を止めずにRLSを閉じるための暫定ブリッジ**であり、
Supabase Auth の代替として完了扱いにはしない。限界: 誰が操作したか識別できない／退職・端末紛失時に
個別失効できない／漏洩時に全スタッフ権限が漏れる／localStorage からXSS等で取得されうる／個人単位の監査不能。
**Supabase Auth によるスタッフ個別アカウント化は、本番一般公開（718件への案内）前のブロッカー**として残す。

暫定期間中の約束（実装済み）: キー未設定時はデータ取得前に確認／認証失敗（スタッフキーが違います）を
一般エラーと区別／キーをURL・Query・Cookieに入れない（HTTPヘッダのみ）／外部ドメインへ送らない
（`order.html` は外部リソースを一切読み込まない）／キーの変更・端末からの削除UI（受発注管理→顧客管理）／
キー変更で全端末が再入力（＝漏洩時の失効手順）／お客様側のAPI呼び出しは認証アダプタ（`order.html` の
`api` オブジェクト）に分離済みで、Auth移行時はそこだけ差し替える。

**キーの変更権限（2026-08-10 改訂）**: スタッフキーの変更には**管理者用回復コード**が必要
（通常のスタッフキーを知っているだけでは変更できない＝スタッフの誰かが全端末を締め出せない）。
旧 `staff_key_set(現在キー, 新キー)` は廃止。変更UIは確認入力必須・新キーは再表示しない・
変更は `security_events` 監査ログに残る・変更後は操作した端末も再認証。

**キー漏洩時の失効手順**: 受発注管理 → 顧客管理 → 「🔑 スタッフキー: 変更する」→
回復コード＋新キー（16文字以上）を入力。DB側の bcrypt/sha256 が即時入れ替わり、
旧キーを覚えている全端末は次の操作から再入力になる。

**回復コードを紛失した場合の復旧手順**: Supabase ダッシュボード → SQL Editor で
`update app_secrets set hash = extensions.crypt('新しい回復コード', extensions.gen_salt('bf')) where key='recovery_code';`
を実行（Supabaseアカウントを持つ管理者のみが可能）。

**試行制限と残存リスク（正直な整理・2026-08-10 レビュー反映で改訂）**:
- **グローバルロックは廃止**（2026-08-10）。当初の「10回/5分で全体ロック」は、キーを知らない
  第三者が意図的に失敗を積むだけで**全スタッフを締め出せるDoS**だったため撤去した。
  試行の記録（`auth_attempts` / `security_events`）は監査用に残る。回復コードの試行ロック
  （5回/15分）は対象が回復操作のみで日常業務を止めないため維持
- 総当たり耐性は**レートでなくキー長で担保**する: 回転時に16文字以上を強制・サーバ生成は
  128bit相当。IP単位の本格的な試行制限は Supabase Auth / Edge 移行時に導入（フェーズ5）
- 照合はハッシュ同士の比較（bcrypt / sha256）のため、比較の時間差からキーは推定できない
- **既知の限界**: `admin_*` RPC 経由の誤キーは例外でトランザクションごと巻き戻るため
  失敗ログが残らない（受け入れ済み。下の「監査ログの残り方一覧」参照）
- anon ロールに `statement_timeout=8s` を設定（高負荷クエリの抑止）

**監査ログの残り方一覧（例外ロールバックとの関係・2026-08-10 整理）**:
PostgreSQL では `raise exception` が同一トランザクションのINSERTを巻き戻すため、
「失敗を例外で返す関数」の失敗ログは残らない。残したい経路は false / jsonb 返却方式にしてある。
- ✅ **残る**: 新規登録の上限到達（`public_signup_request` が `{ok:false}` を返す方式）／
  回復コードの照合失敗（`admin_rotate_staff_key` が false を返す方式）／
  `staff_key_ok()` 直呼びの成功・失敗／キー回転の成功イベント
- ❌ **残らない（受け入れ済み）**: `admin_*` RPC 内部での誤キー例外
  （例外にしないと呼び出し元の業務処理まで進んでしまうため。キー長で総当たりを抑止）

**admin_\* 関数の規約**: `admin_` で始まる関数は必ず共通認証（`staff_key_ok()` または
回復コード照合）を通ること。認証の無い `admin_*` 関数は `pg_proc` を走査する自動テストで
検出する（フェーズ2テストに組込み済み。新しい admin_* を足すときはこのテストが落ちる）。

**実重量精算の方針（方針B・数値基準の統一）**: 一時引当は行わず、確認画面の確定ボタン直前に
同意文を表示する。基準は **20%（超過確認）／50%（お断り）** で DB・画面・運用とも統一:
- 引当が希望量の**50%超**になる場合、注文自体をお断りして数量調整を案内（DBが強制）
- **20%超**は注文を通すが `needs_review` フラグ＋注文メモ【超過確認】で、発送前にセンターが確認
- 引当アルゴリズム上の理論上限は「希望量＋最重量パック1個未満」（古い順に積んで届く解が
  必ず存在するため）。50%ルールはその上のさらに保守的な業務上限

**公開登録の制限と限界（文書化）**: 同一電話24時間1件・全体1時間20件。判定と登録は
advisory lock（電話別＋全体）で直列化し、同時リクエストでも突破されない。
戻り値は `{ok:true, code:…}` / `{ok:false, error:…}` の jsonb（上限到達を例外にすると
監査ログごと巻き戻るため）。受付コードは `S+日時+乱数4桁hex` で、同一秒の連続登録でも
衝突しない（万一の重複時はコードを再生成して再試行）。上限到達は
`security_events` に記録され、受発注管理から `admin_security_events()` で確認できる。
正規顧客はセンターの顧客追加（スタッフキー）でいつでも登録可能。エラー文は
「申し込みを既にお預かり」までで、**既存顧客かどうかは判別できない**（照合対象は
signup-form 由来の直近24時間のみ）。**電話番号を変えた大量登録はこの仕組みでは
1時間20件までしか抑えられない**（既知の限界）。それ以上の Bot 対策が必要になったら
Turnstile 等を登録RPCの引数に追加する（構造はRPC1本なので差し込みは容易）。

### 🔧 2026-08-10 レビュー修正（`migrations/20260810_review_fixes.sql`・DB適用済み）

PR #115 の実差分レビュー（8項目）への対応。全項目を実DBのロールバック付きテストで検証済み。

1. **`resolve_unit_price()` を内部専用に**: anon から実行不可。管理画面の価格確認は
   `admin_resolve_price(スタッフキー, 顧客, 商品)` 経由のみ（個別価格の第三者列挙を遮断）
2. **カタログ表の直接公開を廃止**: `portal_products` / `portal_product_parts` /
   `portal_product_prices` / `customer_product_prices` への anon SELECT を全て撤去。
   お客様はセッション必須の `portal_catalog`、管理画面はスタッフキー必須の
   `admin_list_portal_products`（商品＋部位＋価格＋在庫記号を一括返却）のみ
3. **STABLE / VOLATILE の分離**: `portal_session_customer()` は SQL・STABLE（検証のみ）、
   `last_seen_at` の更新は VOLATILE な `portal_session_touch()`（`clock_timestamp()` 使用。
   `now()` はトランザクション開始時刻で固定されるため不可）。touch を呼ぶのは更新系RPCのみ
4. **グローバルロックの廃止**（上記「試行制限と残存リスク」参照）
5. **受付コードの衝突対策**＋**登録RPCの jsonb 化**（上記「公開登録の制限と限界」参照）
6. **監査ログの残り方の一覧化**（上記参照）
7. 軽微修正: 超過確認は「20%**以上**」（画面文言「2割以上」とDBの判定を一致）／
   冪等キーは**（顧客, リクエストID）で一意**（別顧客が偶然同じIDを送っても独立注文）／
   部位マッピングは「等級問わず」と特定等級の**混在を禁止**（二重計上防止）／
   **ログインはログインID・顧客コードのみ**（お名前ログインは新旧ポータルとも廃止。
   `portal_login_v2` に加え旧 `portal_login` / `portal_change_password` も統一。
   案内文・画面ラベルからも名前ログインの記載を削除）

### 📋 PR #115 マージ後の必須チェックリスト（RLS適用を忘れたまま運用しない）

1. ☐ スタッフキーのローテーション（済 2026-08-10。テスト用キーとも分離済み）
2. ☐ 新規登録の専用RPC化（済）・order.html 完成（済）
3. ☐ PR #115 のレビュー
4. ☐ Preview環境でセンター3画面＋新ポータルを確認
5. ☐ PR #115 をマージ → 本番反映を確認
6. ☐ 本番の3画面が x-staff-key ヘッダを送ることを確認（開発者ツールで1リクエスト見る）
7. ☐ **`migrations/20260809_rls_tighten.sql` を適用**（マージ直後に。適用と検証の間を短く）
8. ☐ ヘッダなしで customers / orders が0件・書込み不可を確認
9. ☐ 正規のセンター画面（キー入力済み）が動作することを確認
10. ☐ 旧ポータルから注文できないことを確認
11. ☐ 問題時: `migrations/rollback/20260809_rls_tighten_rollback.sql`（緊急時のみ・全開放に戻る）

### フェーズ2の実装状況（2026-08-09）

- 実装済み・**DB適用済み**: `portal_sessions` とお客様向けRPC一式（`20260809_portal_sessions_rpc.sql`）。
  トークン発行・カタログ・お気に入り・履歴・再構成・注文確定・センター側のステータス連動と引当内訳。
  新ポータルのログイン（`portal_login_v2`）は `portal_enabled=true` の顧客のみ。
- 実装済み・**未適用**: RLS引き締め（`20260809_rls_tighten.sql`）。
  **適用手順**: ①このブランチ（画面がスタッフキーのヘッダを送る版）を本番へ反映 →
  ②`staff_key_register_header()` の登録を確認（済） → ③`20260809_rls_tighten.sql` を適用。
  先に③をやると本番のセンター画面が読めなくなる。検証は適用→テスト→巻き戻しの
  トランザクションで完了済み（ヘッダ無しで0件・signupフォームは通る・ヘッダ有りで全件）。
- 旧ポータルの注文送信・履歴は停止の案内に切替済み（実顧客の利用ゼロを確認のうえ。
  ポータル経由の注文は過去にテスト太郎の1件のみ）。

> ### 🚧 本番公開のブロッカー（明示）
> **センター側の3画面（`index.html` / `order-admin.html` / `sales-dashboard.html`）が
> 公開ページに埋め込まれた anon キーで全権アクセスしている状態が残っている限り、
> 718件への案内配布（フェーズ6）を実施してはいけません。**
> この状態では、キーを読み取った第三者が全顧客の氏名・住所・電話・全注文履歴を取得し、
> 書き換え・削除もできます。フェーズ5（Supabase Auth 化）の完了が配布の前提条件です。
>
> なお試験運用（フェーズ4）は、対象を数社に限り、その旨を先方に伝えたうえでなら実施可能と考えます。
> ここは施主判断が必要です（§9-5）。

---

## §7 データ移行・ロールバック計画

### 7-1. 原則

- **既存テーブルの列削除・改名・データ削除は行いません。** 追加のみ
- `price_master` / `customer_prices` / `customer_saved_items` / `orders` / `order_items` / `inventory`
  の既存行は書き換えません（`order_items` は**列の追加のみ**）
- 各マイグレーションに対応する**取り消しSQL**を `migrations/rollback/` に同時に置きます

### 7-2. 移行手順

| 手順 | 内容 | 取り消し方法 |
|---|---|---|
| M1 | `portal_products` 等を作成し、**現在の在庫実態から初期データを投入**（人が確認） | テーブルを drop（既存に影響なし） |
| M2 | `customer_saved_items` の `kind='usual'` を `favorite` へ複製（**元行は消さない**） | 複製行を削除 |
| M3 | `order_items` に列追加（すべて nullable） | 列を drop |
| M4 | 請求書ステージング一式を作成 | drop |
| M5 | `customer_purchase_facts` を集計 → `customer_usual_items` を生成 | 再生成のみ。元データは請求書側に残る |
| M6 | `customer_product_prices` へ**人が確認した価格だけ**投入 | 行を削除すればランク価格に戻る |
| M7 | RLS引き締め | ポリシーを元に戻すSQLを用意 |

### 7-3. 切り戻し

- 画面: `order.html` は新規ファイル。問題があれば案内のリンクを `order-portal.html` に戻すだけ
- RPC: `create or replace` のため、旧定義を `migrations/rollback/` に保存
- RLS: フェーズ2で削除するポリシーの定義を事前に控え、復元SQLを用意
- **試験運用中は `order-portal.html` を残し、いつでも戻せる状態を維持します**

---

## §8 テスト計画（要望 §12）

既存流儀（`new Function()` による `<script>` 構文チェック → Playwright E2E → 本番反映）に追加します。

### スマホ（390×844・`isMobile:true`）
- レイアウトが崩れない（横スクロールが出ない）
- 主要ボタン（カート／確認）が下部に固定される
- **いつもの商品から1〜2タップでカート追加できる**
- 商品10件以上でも操作しやすい（1画面あたりの商品数・総スクロール量を計測して閾値判定）
- **注文確定まで3画面以内**
- タップ領域がすべて44px以上

### 請求書
- PDF / 画像 / Excel の取込（モック同梱）
- **同じファイルの再取込で `customer_purchase_facts` が増えない**
- **同名顧客（4組）を誤って結合しない**
- 表記揺れ商品を勝手に統合しない（`未判定` のまま止まる）
- 読取不能箇所が `要確認` になる
- `source_ref` から元ファイル・ページへ追跡できる

### 価格
- 個別価格が価格ランクより優先される
- 個別価格の期限切れ（`valid_until` 経過）でランク価格に落ちる
- 標準価格へのフォールバック
- **価格未設定時は注文不可**
- **クライアントが単価を書き換えても採用されない**（改ざんしたリクエストを送って検証）
- **過去注文後に価格表を変えても過去注文額が変わらない**（スナップショット）

### いつもの商品・再注文
- リピーターだけに初期候補が出る（単発購入の顧客には出ない）
- 単発購入商品が過剰に表示されない
- **お気に入りが自動集計で消えない**（再集計を2回走らせて確認）
- 販売停止商品は再注文されない
- 在庫切れ明細を明示する（勝手に置き換えない）
- 現在価格で再計算される
- **再注文ボタンだけでは注文確定しない**

### 引当
- 超過最小の組み合わせが選ばれる（FIFOより良い解があるケースを用意）
- 同程度なら古い在庫・少ないパック数
- 1点が2注文に引き当たらない（RPCを並列に呼ぶ）
- 不足時は注文全体がロールバックする
- キャンセルで在庫に戻る／二重に戻らない

### 回帰
既存の `custsync` / `indnum` / `rad` / `radscan` / `warn` / `portal-login` / `portal-guide` を毎回実行。

---

## §9 未決事項・施主判断が必要な点

### 9-1. Drive へのアクセス承認 ★至急
Drive MCP が承認待ちで、請求書フォルダを開けません（`requires approval`）。
**承認いただければ経路Aで直接取り込みます。** 難しい場合は経路B（ローカル配置）で進めますので、
どちらにするかお知らせください。承認待ちの間はモックデータで実装とテストを進めます。

### 9-2. 商品マスタの初期構成
在庫にあってカタログに無い商品を、一般のお客様に出すかどうか。特に:

| 在庫 | kg | 出す？ |
|---|---|---|
| ペットフード用（あり）／（なし） | 36.4kg | ペット用として別扱い？ 一般には出さない？ |
| 味肉用 | 6.3kg | |
| チチカブ | 0.4kg | |
| ミンチ用（並）と ミンチ肉（粗挽き）（上） | 53.9kg | **1商品にまとめる？ 別商品として2つ出す？** |
| キョン ロース | 0.14kg | |

**「ミンチ用」と「ミンチ肉（粗挽き）」は等級が違う（並／上）ため、価格が違えば別商品にすべきです。**
ここは商売のご判断が要ります。

### 9-3. 在庫が足りないときの伝え方
「重量は出さない」方針と、注文が通らないときの親切さがぶつかります。
現案は具体量を伏せて「ご用意できる量を超えています。数量を減らしてください」とだけ出します。
「あと2.5kgまでお受けできます」と出したほうが親切ですが、実質的に在庫量を開示することになります。

### 9-4. 価格差が出た顧客の扱い
`portal_enabled` を追加して、価格差が解消するまで案内を有効化しない運用を可能にします。
**既定を「有効」「無効」どちらにしますか。** 推奨は**無効**（確認した顧客から順に開けていく）。

### 9-5. 試験運用の可否
§6 のとおり、センター側の Auth 化が終わるまでは顧客情報が読める状態が残ります。
**数社に限った試験運用を、その状態で始めてよいか**のご判断をお願いします。
推奨は「試験は3〜5社まで・期間を区切って実施、718件への配布は Auth 化後」です。

### 9-6. 在庫データの正確さ
引当を自動化すると、DBの在庫が実物とずれていた場合に「注文は通ったが現物が無い」が起きます。
移行初期は**センター側で必ず目視確認してから確認済にする**運用を挟むことを推奨します。
`inventory.individual_id` が欠けている点があると引当内訳のトレーサビリティが切れるため、
開始前に一度棚卸しをお願いしたいです。

### 9-7. 既存 `order-portal.html` の扱い
新画面 `order.html` に移行後、旧ポータルをいつ閉じるか。
推奨は「試験運用の間は両方残し、本配布のタイミングで旧を閉じる」。

---

## §10 実装ステップ

| フェーズ | 内容 | 主な成果物 |
|---|---|---|
| **1** | 商品マスタ・価格解決・引当 | `migrations/*_portal_products.sql`、`*_allocations.sql`、`resolve_unit_price()`、`portal_place_order()`、受発注管理に商品マスタ編集タブ |
| **2** | セッション・RPC・直接アクセス廃止・RLS引き締め | `portal_sessions`、お客様向けRPC一式、RLSポリシー入れ替え |
| **3** | スマホ注文画面 | `order.html`（3画面・下部固定バー・56px行） |
| **4** | 請求書取込 | ステージング一式、`scripts/import-invoices.mjs`、名寄せ画面、価格差比較表 |
| **5** | いつもの商品の自動抽出 | `customer_usual_items` と再集計処理、管理画面 |
| **6** | センター側 Supabase Auth | 3画面のログイン |
| **7** | 試験運用 → 本配布 | — |

フェーズ1〜3を先に出して現場で試し、4〜5を請求書の到着に合わせて進めます。
**6 は 718件への配布より前に必ず完了させます。**

---

## §11 センター側の管理画面（要望 §11）

受発注管理（`order-admin.html`）に追加するタブと機能:

| 画面 | 内容 |
|---|---|
| 請求書取込 | 取込状況（状態別件数）、ファイル一覧、再取込、除外、元ファイルへのリンク |
| 顧客の照合候補 | 確度つき候補の一覧、確定／別顧客として登録／対象外 |
| 商品の照合候補 | `product_name_aliases` の判定（対応づけ／別商品／対象外）。価格帯の差を併記 |
| 顧客別購入履歴 | `customer_purchase_facts` の一覧（出典の請求書へ追跡可能） |
| いつもの商品 | 顧客ごとの5件、**自動抽出の根拠**、いつもの注文量、固定／非表示の切替 |
| 顧客別価格の差異 | 価格差比較表、個別価格の登録、適用期間の設定 |
| お気に入り | 顧客ごとの★一覧（**センターからは解除しない**。閲覧のみ） |
| 注文詳細 | 再注文元、引当内訳（どの個体のどのパックを何kg）、引当のやり直し・取消 |

**すべての自動判定は人が上書きでき、変更履歴を残します。**

```sql
create table admin_overrides (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,     -- invoice_document / invoice_line / product_alias / usual_item / customer_price
  entity_id   uuid not null,
  field       text not null,
  old_value   jsonb, new_value jsonb,
  reason      text,
  changed_by  text not null,
  changed_at  timestamptz not null default now()
);
```

---

## §12 変更しないもの（安全のため）

- ルートのファイル構成・`sw.js`・`manifest.json`（現場PWAが壊れるため）
- `capture-form.html` / `punch.html` / `outlet.html` / `record-list.html` / `capture-report.html`
- `orders.status` の語彙（`受注` / `確認済` / `発送済` / `キャンセル`）
- `inventory.status` の語彙（`在庫` / `引当済` / `加工済` / `出荷済`）
- 既存の `price_master` / `customer_prices` / `customer_saved_items` の行
