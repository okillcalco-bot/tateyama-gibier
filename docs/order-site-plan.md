# 注文サイト（お客様側／センター側）実装計画書

- 対象リポジトリ: `okillcalco-bot/tateyama-gibier`（ルート直下の静的HTML + Supabase 直結PWA群）
- 作成日: 2026-08-09
- 前提: `CLAUDE.md` のとおり、ルート直下は**本番稼働中**。DBスキーマ変更は `/migrations` に「追加のみ」のSQLを置く既存流儀に従う。
- レビュー観点の要望: **§4 の既知の問題**と **§6 の引当設計**を重点的に見てほしい。

---

## 1. 目的

館山ジビエセンターの取引先（飲食店・小売店 718件）が、**いま施設にある在庫の範囲で**Webから注文でき、
その注文が**センター側の注文一覧に自動で溜まる**状態にする。お客様側とセンター側を同時に成立させる。

現状は電話・FAX中心。注文ポータル自体は存在するが、後述のとおり**在庫とつながっていない**。

## 2. 現状（2026-08-09 時点）

### 2.1 すでに動いているもの

| 画面 | ファイル | 状態 |
|---|---|---|
| 注文ポータル（お客様） | `order-portal.html` (約980行) | ログイン／カート／注文送信／履歴／再注文／マイリスト |
| 受発注管理（センター） | `order-admin.html` (約2300行) | 注文一覧／発送管理／書類発行／請求書／顧客管理／価格マスタ |
| 業務アプリ | `index.html` (約9000行) | 個体・在庫・出荷・顧客台帳 |

実績: 注文 11件 / 3社（2026-03-23 〜 2026-08-07）。ほぼ未稼働。

### 2.2 直近で入れた土台（PR #113, #114）

- 顧客管理に「注文ポータルのご案内」— ログインIDの配布と案内文の生成（メール/LINE/はがき/電話）
- パスワードを `customer_secrets` に bcrypt 保管し、`portal_login()` / `portal_change_password()` /
  `staff_issue_portal_passwords()`（SECURITY DEFINER）経由に変更。平文はDBから消す直前
- ポータルにベタ書きされていた代理ログインの合言葉を廃止

### 2.3 決まっている方針（施主判断・2026-08-09）

| 論点 | 決定 |
|---|---|
| 在庫の見せ方 | **あり・なしだけ**（◎／△／×）。**重量は出さない**。注文は kg 指定 |
| 引当のしかた | **注文が入った時点で「引当済」**にして、他のお客様から見えなくする |
| セキュリティ | 案内の配布より先に直す（進行中） |

## 3. 現状のデータ構造

### 3.1 `inventory`（在庫。1行＝1点の現物）

```
id uuid / individual_id text(FK→individuals.label_id) / species text / part_name text
grade text('並'|'上')  weight numeric  weight_kg numeric   ← 両方 kg。値は同一で冗長
status text('在庫'|'引当済'|'加工済'|'出荷済')  unit_price int  lot_code / location_code
tier int  parent_inventory_id uuid  deleted_at
```

現在の在庫（`status='在庫'` かつ `deleted_at is null`）: **111点 / 約124kg**

| 種 | 部位 | 等級 | 点数 | kg |
|---|---|---|---|---|
| イノシシ | ミンチ用 | 並 | 20 | 29.94 |
| イノシシ | ミンチ肉（粗挽き） | 上 | 24 | 24.00 |
| イノシシ | ペットフード用（なし） | 並 | 18 | 22.43 |
| イノシシ | ペットフード用（あり） | 並 | 7 | 13.95 |
| イノシシ | カタ | 並 | 6 | 9.42 |
| イノシシ | バラ | 並 | 5 | 7.26 |
| イノシシ | 味肉用 | 並 | 4 | 6.25 |
| イノシシ | スネ | 並 | 9 | 4.17 |
| イノシシ | ロース | 並 | 4 | 2.60 |
| イノシシ | 肩ロース | 並 | 3 | 2.13 |
| イノシシ | ネック / ヒレ / チチカブ | 並 | 6 | 2.21 |
| シカ | ロース / モモ（ウチ） | 並 | 4 | 0.98 |
| キョン | ロース | 並 | 1 | 0.14 |

1点あたりの重量は **0.05kg 〜 3.53kg**。ばらつきが大きい。

### 3.2 `orders` / `order_items`

```
orders:      id / order_code / customer_id / customer_name / order_date / delivery_date
             delivery_time_zone / delivery_* / status('受付'既定) / total_amount
             price_rank / channel('ポータル'既定) / carrier / memo / notes
order_items: id / order_id / inventory_id(uuid・単一) / product_id / species / part_name
             weight numeric / weight_kg numeric / unit_price int / amount int / subtotal numeric
```

実際に使われている値:
- `orders.status` = `受注` / `確認済` / `発送済` / `キャンセル`
- `orders.channel` = `ポータル` / `BASEネットショップ` / `直販（注文なし）` / `練習`

### 3.3 `price_master`（カタログ）

`species / part_name / grade('並'|'上'|'極上') / barcode_num / price_standard / price_local /
price_startmember / price_premium / price_wholesale`

ポータルは `grade='上' and barcode_num is not null` の行だけを商品として出し、
`customers.price_rank`（現在は全件 `standard`）で単価を選んでいる。

---

## 4. 調査で分かった既知の問題（**要レビュー**）

### 4.1 カタログと在庫の部位名が半分しか一致しない ★重要

ポータルが出しているカタログ（`price_master` 上・バーコード有）と、実在庫の `part_name` を突き合わせた結果:

| 判定 | 件数 | 例 |
|---|---|---|
| 一致 | 8 | スネ / ネック / バラ / ヒレ / ミンチ用 / ロース / 肩ロース / シカ ロース |
| **在庫にあるがカタログに無い** | 8 | 在庫`カタ` ↔ カタログ`カタ（ウデ）` ／ 在庫`ミンチ肉（粗挽き）` ↔ カタログ`ミンチ肉` ／ 在庫`ペットフード用（あり）`・`ペットフード用（なし）` ↔ カタログ`ペットフード用` ／ 在庫`味肉用`・`チチカブ`（カタログに該当なし）／ 在庫`シカ モモ（ウチ）` ↔ カタログ`シカ モモ` ／ 在庫`キョン ロース`（キョン自体がカタログに無い） |
| カタログにあるが在庫なし | 30 | 内臓各種 / 中型獣ほぼ全部 |

**在庫の約6割（kgベース）がカタログに載っていない部位名**である。`part_name` の文字列一致で
在庫とカタログを結ぶ設計にすると、主力のミンチ・ペットフードが注文できない。

→ 対応案は §5.1。

### 4.2 等級のねじれ ★重要

在庫は **並が主体**（111点中 87点が `並`）だが、ポータルは `grade='上'` の価格しか出していない。
「上の値段で注文を受けて、並を出荷する」状態になりうる。

### 4.3 `order_items.inventory_id` が単一UUID

kg 指定の注文は**複数点にまたがる**（例: ロース 2.0kg = 0.65+0.72+0.81kg の3点）。
1行に1つしか在庫IDを持てないので、引当の記録ができない。

### 4.4 同時注文の競合

2人が同時に同じ部位を注文すると、素朴な `SELECT → UPDATE` では同じ点を二重に引き当てる。

### 4.5 `channel` の値がそろっていない（軽微）

`order-portal.html:934` は `channel:'portal'`（英字）を入れているが、
DBの既定値と他の実績値は `'ポータル'`（日本語）。受発注管理の絞り込みが効かない。

### 4.6 `weight` と `weight_kg` の二重持ち（軽微）

`inventory` / `order_items` の両方に同義の列がある。値は現状すべて同一（kg）。
新規コードは `coalesce(weight_kg, weight)` で読み、書くときは両方に入れる（既存画面が `weight` を見ているため）。

### 4.7 まだ残っているセキュリティ上の穴 ★重要

`customers` / `orders` / `order_items` は依然 `anon` に `ALL / qual=true` のRLSポリシーが付いており、
公開ページに埋め込まれた anon キーで **718件の氏名・住所・電話と全注文履歴が読める**。
パスワードは PR #114 で切り離したが、ここは未対応。

センター側3画面（`index.html` / `order-admin.html` / `sales-dashboard.html`）が anon キーで
全権アクセスしているため、**本物のログイン（Supabase Auth）を入れないと塞げない**。
本計画とは別タスクだが、注文履歴を扱う以上、本番公開前に済ませたい。

---

## 5. 設計

### 5.1 商品マスタを1枚かませる（4.1 / 4.2 への対応）

`price_master` を直接カタログにするのをやめ、**表示用の商品**と**在庫の部位**を結ぶ表を追加する。

```sql
create table portal_products (
  id            uuid primary key default gen_random_uuid(),
  species       text not null,            -- イノシシ / シカ / キョン
  display_name  text not null,            -- お客様に見せる名前（例: 猪ミンチ 粗挽き）
  sort_order    int  not null default 100,
  description   text,                     -- 「煮込み向き」等
  min_order_kg  numeric not null default 0.5,
  step_kg       numeric not null default 0.5,
  low_kg        numeric not null default 3.0,   -- これ未満は △
  is_active     boolean not null default true,
  created_at    timestamptz default now()
);

-- 1商品 = 在庫の部位×等級の組み合わせ（複数可）
create table portal_product_parts (
  product_id  uuid not null references portal_products(id) on delete cascade,
  part_name   text not null,
  grade       text,                       -- null = 等級を問わない
  primary key (product_id, part_name, coalesce(grade,''))
);

-- 商品ごと・価格ランクごとの単価（price_master と切り離す）
create table portal_product_prices (
  product_id uuid not null references portal_products(id) on delete cascade,
  price_rank text not null,               -- standard / local / startmember
  unit_price int  not null,
  primary key (product_id, price_rank)
);
```

- 初期データは現在の在庫実態から作る（ミンチ用＋ミンチ肉（粗挽き）を1商品にまとめる等）。
- 受発注管理の「価格マスタ」タブに商品の編集UIを足す。
- **代案**: `price_master` に `alias` 列を足して文字列を寄せるだけ。安いが、
  「ミンチ用（並）とミンチ肉（粗挽き）（上）を1つの商品として売る」ができない。→ 採らない。

### 5.2 在庫の◎△×（決定方針: 重量は出さない）

在庫の残量は**ビュー**で出し、しきい値で記号に落とす。

```sql
create view portal_stock as
select p.id as product_id, p.species, p.display_name, p.sort_order, p.min_order_kg, p.step_kg,
       coalesce(sum(i.weight_kg), 0) as avail_kg,   -- ← 画面には出さない
       count(i.id) as pcs
  from portal_products p
  left join portal_product_parts pp on pp.product_id = p.id
  left join inventory i
         on i.deleted_at is null
        and i.status = '在庫'
        and i.species = p.species
        and i.part_name = pp.part_name
        and (pp.grade is null or i.grade = pp.grade)
 where p.is_active
 group by p.id;
```

記号の決め方（お客様側で `avail_kg` から算出。**APIレスポンスに `avail_kg` を含めない**のが要件）:

| 記号 | 条件 | 表示 |
|---|---|---|
| ◎ | `avail_kg >= low_kg` | ご用意できます |
| △ | `min_order_kg <= avail_kg < low_kg` | 残りわずか |
| × | `avail_kg < min_order_kg` | 在庫切れ（注文不可） |

→ **`avail_kg` をクライアントに渡さない**ため、記号への変換はDB側（ビュー or RPC）で行い、
`portal_stock_public`（`product_id, species, display_name, mark, min_order_kg, step_kg, unit_price`）
だけを返す。ここは要レビュー: 「見せない」を本気でやるならサーバ側で落とす必要がある。

### 5.3 引当（決定方針: 注文時に引当済）★要レビュー

```sql
create table inventory_allocations (
  id            uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references order_items(id) on delete cascade,
  inventory_id  uuid not null references inventory(id),
  weight_kg     numeric not null,
  created_at    timestamptz default now()
);
create unique index on inventory_allocations(inventory_id)
  where true;   -- 1点は同時に1注文にしか引き当てない
```

注文確定は **1本のRPC**（SECURITY DEFINER・トランザクション）で行う:

```
portal_place_order(p_login_token, p_items jsonb, p_delivery_date, p_time_zone, p_memo)
```

処理:
1. お客様を特定（§5.5 のトークン）
2. `orders` を1行 INSERT（`status='受注'`, `channel='ポータル'`）
3. 各明細について:
   - `select ... from inventory where 部位一致 and status='在庫' and deleted_at is null
      order by processed_at asc for update skip locked`
     → **`FOR UPDATE SKIP LOCKED`** で 4.4 の競合を防ぐ
   - 古い順（先入先出）に積み、**注文kgを下回らない**ところまで取る
   - 上限ガード: 積み上げが `注文kg × 1.25` を超える点は取らない
   - 足りなければ **注文全体をロールバック**し、`不足` を返す
   - 取った点を `status='引当済'` に更新し、`inventory_allocations` に記録
   - `order_items` の `weight_kg` は**実際に引き当てた合計kg**で書く（注文kgは `notes` 相当に残す）
4. `orders.total_amount` を再計算して返す

**端数の扱い（要レビュー）**: 現物なので注文2.0kgに対して実引当2.18kgのようになる。
ジビエの慣行としては現物重量での精算が自然だが、
「注文より多い量が届いて請求される」ことになるため、以下のどちらかを選ぶ必要がある。

- **案A（推奨）**: 下回らないように積み、実重量で精算。ポータルに
  「お受けした量 2.18kg（ご注文 2.0kg）／現物のため多少前後します」と明示し、注文前にも注記を出す。
- 案B: 注文kgを超えない範囲で積む（1.53kg で確定）。不足感が出る。
- 案C: 引当はせず、センターが実物を見て確定してから数量を決める → 施主の決定（注文時に引当）と矛盾。

キャンセル・戻し:
- `orders.status='キャンセル'` にしたとき、`inventory_allocations` を辿って `引当済 → 在庫` に戻す
- 出荷確定（`発送済`）で `引当済 → 出荷済` にする
- 受発注管理から明細単位で引当を外す操作も用意する

### 5.4 センター側（受発注管理）

- 注文一覧に **「新着」バッジ**（`channel='ポータル' and status='受注'`）
- 注文詳細に**引当の内訳**（どの個体のどの点を何kg取ったか＝トレーサビリティ）
- 引当の**やり直し**（別の点に差し替え）／**取り消し**
- 商品マスタ（§5.1）の編集タブ
- 在庫が `低` になった商品の一覧（欠品予告）

### 5.5 お客様の識別（§4.7 への部分対応）

現在ポータルは `customers` / `orders` / `order_items` を anon で直接読み書きしている。
注文サイトの実装にあわせて、**お客様側の読み書きはすべてRPC経由**に寄せる。

- `portal_login()` が**セッショントークン**を発行（`portal_sessions` に保管・有効期限あり）
- `portal_my_orders(token)` / `portal_place_order(token, ...)` / `portal_saved_items(token, ...)`
- これによりポータル側から `customers` / `orders` を直読みする必要がなくなり、
  **anon の SELECT ポリシーを外せる**（センター側3画面の Supabase Auth 化は別途必要）

---

## 6. 実装ステップ

| # | 内容 | 変更ファイル | 目安 |
|---|---|---|---|
| 1 | 商品マスタ 3テーブル + 初期データ + `portal_stock` ビュー | `migrations/2026xxxx_portal_products.sql` | 小 |
| 2 | 受発注管理に「商品マスタ」編集タブ | `order-admin.html` | 中 |
| 3 | `inventory_allocations` + `portal_place_order()` RPC | `migrations/2026xxxx_allocations.sql` | **大（核）** |
| 4 | ポータルを◎△×表示＋RPC注文に差し替え | `order-portal.html` | 中 |
| 5 | 受発注管理に新着バッジ・引当内訳・引当のやり直し | `order-admin.html` | 中 |
| 6 | セッショントークン化（§5.5）とRLS引き締め | `migrations` + `order-portal.html` | 中 |
| 7 | `channel` の値の統一（4.5）と既存データの是正 | `order-portal.html` + 1行UPDATE | 小 |

**1〜5 を先に出して現場で試し、6 は案内の一斉配布前に必ず入れる。**

## 7. テスト計画

既存流儀に合わせ、Playwright（chromium: `/opt/pw-browsers/chromium/chrome-linux/chrome`）で
`<script>` ごとの構文チェック → E2E → 本番反映。DBはルートで差し替え（`page.route`）してモック。

- **在庫表示**: ◎△×の境界（`avail_kg` が `low_kg` ちょうど／`min_order_kg` ちょうど）、×は注文不可、
  **APIレスポンスに実重量が含まれないこと**
- **引当**: 端数（2.0kg 注文 → 複数点）、在庫ぴったり、在庫不足でロールバック、
  上限ガード（1.25倍を超えない）、先入先出の順序
- **競合**: 同一商品への同時注文2本で二重引当が起きないこと（RPCを並列に呼ぶ）
- **キャンセル**: 引当が `在庫` に戻ること、二重に戻らないこと
- **センター側**: 新着バッジ、引当内訳の表示、引当のやり直し
- **回帰**: 既存の `custsync` / `indnum` / `rad` / `radscan` / `warn` / `portal-login` / `portal-guide`

## 8. リスク・未決事項（**レビューで判断がほしい点**）

1. **§5.3 の端数の扱い（案A/B/C）** — 商売のルールに関わる。推奨は案A
2. **§5.2 で在庫切れ・数量オーバー時に「あと何kgまで」を伝えるか**
   「重量を出さない」方針と、注文が通らないときの親切さがぶつかる。
   現案は「ご用意できる量を超えています」とだけ出して具体量は伏せる
3. **§5.1 の商品マスタ初期データ**（何を1商品にまとめ、何を出さないか）は施主の確認が要る。
   特に「ペットフード用（あり／なし）」「味肉用」「チチカブ」を一般のお客様に出すかどうか
4. **§4.7 のセンター側 Supabase Auth 化** — 本計画の外だが、注文履歴を扱う以上は前提条件に近い
5. **在庫の実態がどれだけ正確か** — 引当を自動化すると、DBの在庫がずれていた場合に
   「注文は通ったが現物が無い」が起きる。移行初期はセンター側で必ず目視確認する運用を挟む
6. `individuals` との紐付け（`inventory.individual_id`）が欠けている点があると、
   引当内訳のトレーサビリティが切れる。事前に棚卸しが必要かもしれない

## 9. 変更しないもの（安全のため）

- ルートのファイル構成・`sw.js`・`manifest.json`（現場PWAが壊れるため）
- `capture-form.html` / `punch.html` / `outlet.html` / `record-list.html` / `capture-report.html`
  （顧客・注文データに触れていないため無関係）
- `orders.status` の語彙（`受注` / `確認済` / `発送済` / `キャンセル`）
- 既存の `inventory.status` の語彙（`在庫` / `引当済` / `加工済` / `出荷済`）
