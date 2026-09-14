# 「1個体の一生」の線を太くする — 送料の空欄をなくす／一生ビューに出店と声をつなぐ — Codex レビュー依頼（第2版）

軸（CLAUDE.md）: **生態 → 個体 → 精肉 → 加工 → 販売 → 食べた人の声 が1本の線で繋がっていること。**
この軸を変えず、実測で見つかった「線が切れている2か所」を直した。
**DBスキーマ・RLS・権限・DB関数・既存データは一切変更していない。マイグレーションもない。**

第2版は、第1版（コミット ba145b1）を最新 main（PR #253〜#256）の上に載せ替え、自己レビューで見つけた
軽微な不具合3件と表示1件を直したもの。第1版の変更は重ねて修正していない（下記「前回指摘の対応表」）。

## 1. 所在

| 項目 | 値 |
|---|---|
| repository | okillcalco-bot/tateyama-gibier |
| branch | `claude/alco-os-architecture-n56n5z` |
| base（origin/main） | `5bfaa47`（PR #256 まで） |
| head | 本文末尾「提出物」に記載（コミット後のSHA） |
| PR | 本文末尾「提出物」に記載（Draft・merge しない） |
| 未コミット変更 | なし（提出時点で全部コミット済み。ただし **本番未デプロイ**） |

### 関連ブランチ・PR（今回の対象との関係）
- **PR #252（main に入っている）**: 同じ一生ビューと直販確定を触った。その上にリベース済み。一生ビューの声は
  #252 の「`meal_voices` を画面から直接 GET」を採用せず RPC 経由にした（理由は §4-3）。
- **PR #243（Draft・未マージ・本番未適用）P0-A セキュリティ是正**: `staff_voices_list` を staff-key 必須のラッパーに
  置き換える（`20260901_p0_rpc_least_privilege.sql`）。マージされると一生ビューの「承認待ち件数」取得が
  `42501` で失敗する。本変更はその失敗を **「0件」と区別して画面に出す**ようにしてある（§4-4）。#243 側で
  `staffKeyEnsure()` を一生ビューにも掛けるか、承認待ち件数を諦めるかは #243 マージ時の判断（§8）。
- **PR #101（未マージ・8月）受発注管理の送料自動計算（app_settings に料金表）**: main はその後 `shipping_rates` /
  `shipping_areas` テーブル + `tgc_compute_freight` で同機能を別実装済み（20260824）。本変更はテーブル側を使う。
  #101 は設計が重複するため、そのままマージしないこと（本変更の対象外）。
- 他の open PR（#98〜#100・#102・#157）は alco-os / capture-form / order-admin 側で、本変更と重ならない。

## 2. まず測った（本番・SELECT のみ・2026-09-03）

| 区間 | 08-26 基準 | 09-03 実測 | 見方 |
|---|---|---|---|
| 個体 | 600 | **634** | `individuals`（deleted_at null・AUTO- 除く） |
| → 精肉 | 235 | **402** | `inventory.tier=2` を持つ個体 |
| → 加工 | — | **19** | `processing_log` → `inventory.tier=3` |
| → 販売 | 49 | **65**（注文64・出店11・出店のみ1） | `order_items→inventory` ＋ `sale_event_items.individual_label / member_labels` |
| → 声 | 0 | **0**（承認待ちも0） | `meal_voices` |
| 出荷の送料 | 27件中0 | **35件中0**（08-26以降の9件も0） | `shipments.freight` |
| 生態: 緯度経度/推定年齢/体長/餌/胃内容物 | 1/0/0/0/— | **1/0/8/0/0** | `individuals` 各列 |

### 切れていた場所と原因
1. **送料が1件も保存されていない（35/35）。** 08-24 に送料の自動計算（`tgc_compute_freight`・住所→都道府県→地域）を
   入れたのに、その後の9件も全部空。直近の直販出荷の出荷先8件のうち **6件は顧客台帳に住所が無い**。
   コードは「住所が分からなければ自動計算を諦めて『直接入力してください』と出す」だけで、
   確定時は「未入力（あとで請求書に反映されません）」と**表示して通していた**。
2. **一生ビューの「こえ」が固定で「準備中」**（#252 で着手済み）。加えて「とどけた先」は `order_items` 経由だけを見ていて、
   **出店・直売会（`sale_event_items`）で売れた分**（11頭。うち1頭は出店でしか売れていない）が線に載っていなかった。
3. 精肉→販売の断絶（402→65）は業務側（保管中・加工に回る等）でコードの欠陥ではない。生態データ（体長8・胃内容物0）は
   入力欄ができて日が浅い。いずれも今回は触らない。

## 3. 前回（第1版）のレビュー観点の対応表

第1版で「レビューで見てほしい点」として挙げた8点を、現在のコードで再確認した。Codex からの指摘文は
受け取っていないため、対象は第1版の観点リストである。

| # | 観点 | 状態 | 現在のコードでの確認 |
|---|---|---|---|
| 1 | 住所不明時の仮置き「関東」 | **未解消（判断待ち）** | コードは既定「関東」＋画面に「仮定」と明示のまま。「必ず選ばせる」方式に変えるかは人の判断（§8） |
| 2 | 「発送」で送料が空なら確定しない | **未解消（判断待ち）** | ガードはそのまま。出口（地域選択／金額／着払い0／手渡し）を toast に明記 |
| 3 | `meal_voices` を RLS deny-all のまま RPC で読む | **解消済み（設計として維持）** | `story_get_individual`（公開済み）＋ `staff_voices_list('pending')`（件数）。第2版で **取得失敗を「0件」と区別**（§4-4） |
| 4 | `shipping_rates` / `shipping_areas` を anon から直接読む | **現状では問題なし** | 両テーブルは RLS 無効・料金表のみ（本番 pg_policies で確認）。読めない場合の再試行を第2版で追加（§4-2） |
| 5 | `shipDirectFreightAuto` の非同期順序 | **1件解消** | `shipFreightSeq` の破棄は正しい。ただし「自動計算で入った金額が出荷先変更で残る」を発見→第2版で修正（§4-1） |
| 6 | `or=(individual_label.eq.X,member_labels.cs.{X})` の全角・エンコード | **現状では再現しない** | サンドボックスから REST へ直接は出られない（proxy 403）ため、同じ述語を SQL で本番に実行して該当行を確認（`individual_label = X or member_labels @> array[X]` → 1行）。PostgREST の `cs` は `{}` リテラルで配列包含。全角は `encodeURIComponent` 済み。E2E は URL 文字列を検証 |
| 7 | 既存テストの意図（住所不明→手入力を促す）の置き換え | **解消済み** | 「住所不明→地域から算出＋仮定の明示」に置き換え、旧意図は「料金表に無い組合せ→手入力を促す」として残した |
| 8 | 触っていない範囲の確認 | **解消済み** | `git diff --stat origin/main...HEAD` の対象は index.html / tests/e2e 4本 / CLAUDE.md / 本書のみ |

## 4. 変更内容（第1版 ＋ 第2版）

すべて `index.html`（ジビエ基幹・静的PWA）。関数追加と数か所の置換。sw.js / manifest.json は触っていない。

### 4-1. 直販出荷の送料 — 住所が分からなくても「届け先の地域」から必ず出す（第1版）
- **何が起きる問題か**: 住所不明の出荷先では送料欄が空のまま「発送」で確定され、請求書・納品書の送料欄が全部空になる（35/35）。
- **何を直すか**: 「届け先の地域」select（`#ship-direct-area`）を追加。料金表 `shipping_rates` / `shipping_areas` を端末に一度読む。
  送料は2段: ①住所が分かる → 従来どおり DB の `tgc_compute_freight` を正とし、住所の都道府県から地域も自動選択
  ②住所不明／DBで引けない → 画面の地域（既定「関東」。**仮置きであることを画面に明示**）で料金表から算出。
  確定前ガード: 「発送」で送料が空なら確定直前に再計算、それでも空なら **確定しない**（toast で出口を示す）。
- **既存動作への影響**: 住所が分かる出荷先の計算経路（RPC）と、手入力最優先・手渡し（送料なし）は変えていない。
  変わるのは「住所不明で空欄のまま確定できた」→「地域から金額が入る／出せなければ止まる」。
  保存本体（`recordDirectShipment` / `delivery.freight`）は #252 のまま。

### 4-1'. 第2版: 自動計算の金額が出荷先を変えても残る（発見→修正）
- **何が起きる問題か**: 店Aの住所で自動計算した金額が入った状態で出荷先を店B（住所不明・別地域）に変えると、
  「値が入っている＝手入力」と見なして再計算せず、**Aの送料のままBの出荷が確定できる**。
- **何を直すか**: `shipFreightAutoFilled` フラグを追加。自動計算で入れた金額は出荷先変更（`force=false`）で計算し直す。
  手入力（`input` イベント）でフラグを落とし、以後は上書きしない。料金表に無い組合せで再計算したとき、
  **消すのは自動計算の金額だけ**で手入力は残す（第1版は手入力も消していた＝退行だったので直した）。
- **既存動作への影響**: 手入力の尊重は強くなる方向。自動計算の金額だけが追従する。

### 4-2. 第2版: 料金表を一度読めなかった端末が以後ずっと手入力になる（発見→修正）
- **何が起きる問題か**: `shipLoadRates` が通信失敗すると空配列をキャッシュし、リロードまで自動計算が一切効かない。
- **何を直すか**: 失敗時はキャッシュしない（次の操作で読み直す）。読めていない時の案内文を
  「料金表を読み込めませんでした。↻ 再計算を押すか、送料を直接入力してください」に。
- **既存動作への影響**: なし（成功時の挙動は同じ）。

### 4-3. 第2版: 「クール便は120サイズまで」と決め打ちの文言（表示の不整合→修正）
- **何が起きる問題か**: 料金表に無い組合せの案内が「クール便は120サイズまで」固定で、佐川（140にクールあり）や
  サイズ自体が無い場合に誤った説明になる。
- **何を直すか**: `shipRateMissingMsg()` で料金表から **その運送会社・地域で実際にあるサイズ**を列挙して案内する。
  BASE 側（`baseFreightAuto`）も同じ関数を使う。
- **既存動作への影響**: 文言のみ。

### 4-4. BASE注文の発送 — 購入者の都道府県から送料を先に入れる（第1版）
- **何が起きる問題か**: BASE の発送処理でも送料欄は手入力のみで、直近4件すべて空。
- **何を直すか**: `base_order_detail` の `order.prefecture` → 地域 → 料金表で `baseFreightAuto(key,false)` が先に埋める。
  運送会社・サイズ・クールの変更で再計算。発送処理直前にも空なら再計算。
- **既存動作への影響**: BASE 経路は従来どおり「それでも空なら記録だけ進める」（料金表が読めない環境で発送が止まらない。E2Eで固定）。

### 4-5. 個体の一生ビュー — 「とどけた先」に出店を載せ、「こえ」を本物につなぐ（第1版 ＋ 第2版）
- **何が起きる問題か**: 出店で売れた個体が「まだ販売の記録がひも付いていません」と出る。声は #252 が
  `meal_voices` を画面から直接 GET しているが、本番の `meal_voices` は RLS `meal_voices_deny`（public / ALL /
  `USING false`）のため **anon からは常に0件が静かに返る**（エラーにならない）。
- **何を直すか**:
  - 出店: `sale_event_items` を `or=(individual_label.eq.X,member_labels.cs.{X})` で引き、`sale_events` と結合して
    「とどけた先」に行を追加（🏕 会場／品名（n頭のブレンド）／売れた数/持出数／開催日）。段階「とどけた」に出店回数。
  - 声: 物語ページ（s.html）と同じ `story_get_individual`（SECURITY DEFINER・公開済みのみ）で公開済みの声を表示、
    `staff_voices_list('pending')` をこの個体で絞って承認待ち件数＋声タブへのボタン。未公開の本文は出さない
    （「承認してから公開」#221 の建付けを崩さない）。
  - **第2版**: 承認待ち件数の取得失敗（権限・通信）を `null` にして「承認待ちの件数は取得できませんでした（権限か通信）」と表示。
    「0件」と区別する（サイレント失敗を作らない）。#243 マージ後に効いてくる。
  - 各取得は個別 try/catch。RPC が 404 でも一生ビュー全体は落ちない（E2Eで 404 を流して確認）。
- **既存動作への影響**: 一生ビューは読み取り専用のまま。書き込み経路なし。`#252` の①ラベルQR・②出荷先必須はそのまま。
  #252 の E2E（`line-voice-and-shipment-link`）③をこの取り方に合わせて書き換えた（`meal_voices` を直接読まないことも検証）。

## 5. DB・既存データ・設計方針への変更有無（確認根拠）

- **DB スキーマ・RLS・権限・関数**: 変更なし。`git diff --stat origin/main...HEAD` に `migrations/` も `alco-os/supabase/` も含まれない。
- **既存データ**: 変更なし。本番への操作は `SELECT` のみ（実測SQLは §10）。過去35件の `shipments.freight` は追記していない。
- **書き込みの意味**: `shipments.freight` に入る値が「空」→「計算値」になるだけ。列・型・制約は同じ。`orders / order_items / inventory`
  への書き込み内容は #252 の `recordDirectShipment` のまま。
- **公開／非公開境界**: `meal_voices` は RLS deny-all のまま RPC 経由。`shipping_rates` / `shipping_areas` は元から RLS 無効の料金表。
- **認証・認可**: 変更なし。staff-key を要する操作を増やしても減らしてもいない。
- **既存画面・外部連携**: 直販出荷／BASE発送／一生ビューの表示・入力項目の追加のみ。s.html・注文ポータル・LINE は触っていない。

## 6. 今回の制約内では未解決（DB側の変更が必要。**適用していない**。最小変更案のみ）

| 問題 | なぜアプリ側だけでは解決しないか | 最小変更案（未適用） |
|---|---|---|
| 承認待ちの声をこの個体だけ取りたい | `meal_voices` は deny-all。`staff_voices_list('pending',500)` を端末で絞るのは 500 件超で漏れる | `staff_voices_list_by_label(p_label text)`（SECURITY DEFINER・件数と status のみ返す）を追加。#243 のラッパー方針（staff-key）に合わせる |
| #243 適用後、一生ビューの承認待ち件数が取れなくなる | `staff_voices_list` が staff-key 必須になる（#243）。index.html は anon キー直結 | #243 側で「承認待ちの**件数だけ**返す」軽い RPC を anon 許可にするか、一生ビューでも `staffKeyEnsure()` を掛ける。どちらも #243 と同時に決める |
| 出店で売れた個体の把握が `member_labels` 配列の全文走査 | `sale_event_items.member_labels` に GIN index が無い（現状13行なので実害なし） | 行数が増えたら `create index ... using gin (member_labels)`。今は不要 |
| 手動「出荷済」（`changeStatus`）の出荷に送料が無い | #252 が作る出荷は「手渡し相当」で配送情報を持たない。送料を持たせるには UI の追加が要る（今回の対象外） | 業務判断（手動出荷済に発送があるか）を確認してから |

## 7. 検証

### 実施したもの（ローカル・Playwright・ネットワークは全部モック。本番DBへの書き込みなし）
- 修正前の再現: 第1版時点の E2E「住所不明なら手入力を促す」（旧 direct-ship-freight）が、空欄のまま確定できることを示していた。
  本番データでも直近の直販出荷（住所無し6件）がすべて `freight null`（§2）。
- 修正後の解消と回帰（最終コード・単独実行）:
  `direct-ship-freight` **33/33** / `base-ship-freight` **18/18** / `individual-life` **27/27** /
  `line-voice-and-shipment-link` **18/18** / `label-layout-overlap` **19/19**
- 全57本の一括実行（直列・他のブラウザテストを並走させない）: 結果は §11。
- 本番の読み取りで、PostgREST の述語と同じ SQL（`individual_label = X or member_labels @> array[X]`）が対象行を返すことを確認。

### 実施できなかったもの
- **本番 REST への直接リクエスト**（PostgREST の URL 構文そのものの実機確認）: サンドボックスの egress が supabase.co への
  CONNECT を 403 で拒否。E2E はモックの URL 文字列を検証しているだけ。→ デプロイ後、出店で売れた個体（例 TGC-08-T276）の
  一生ビューで「とどけた先」に 🏕 の行が出ることを目視確認してほしい（§8）。
- 実機のスマホでの直販出荷（UI の並び・タップ）: 未実施。
- `tests/e2e` の既存ドリフト5本（capture-* 4本・seika-ident-reuse）: 変更前の HEAD でも同じ失敗。今回は直していない。

## 8. 人の判断が必要な事項

1. 住所不明時の仮置きを「関東」にした（従来は空欄）。間違った金額 vs 空欄のトレードオフ。「必ず地域を選ばせる」に変えるか。
2. 直販「発送」で送料が空なら確定しない。現場で止まる場面があれば緩める。
3. 過去35件の送料の追記（元データは書き換えない方針。`carrier/size_code/is_cool` が入っている6件は料金表から埋められる）。
4. #243 マージ時の一生ビューの承認待ち件数の扱い（§6）。
5. デプロイ後の実機確認: TGC-08-T276 の一生ビュー（出店の行）／住所の無い出荷先での直販出荷（地域「関東」で金額が入る）。

## 9. 見送ったもの（別PR）
- 注文経由の出荷（`shipOrderConfirmed`）への地域フォールバック（実データで住所空の注文が出ていない）。
- 既存E2E 5本のドリフト修正。

## 10. 実測SQL（次回の計測用・読み取りのみ）

```sql
with ind as (select * from individuals where deleted_at is null and label_id not like 'AUTO-%'),
t2 as (select distinct individual_id as label from inventory where deleted_at is null and tier = 2),
t3 as (select distinct l.individual_id as label from processing_log l
       join inventory p on p.individual_code = l.child_ident_code and p.tier = 3 and p.deleted_at is null
       where l.individual_id is not null),
so as (select distinct coalesce(iv.individual_id, iv.individual_code) as label
       from order_items oi join inventory iv on iv.id = oi.inventory_id),
se as (select distinct individual_label as label from sale_event_items where individual_label is not null
       union select distinct unnest(member_labels) from sale_event_items where member_labels is not null),
vo as (select distinct individual_label as label from meal_voices where deleted_at is null)
select
  (select count(*) from ind) as individuals,
  (select count(*) from ind where label_id in (select label from t2)) as seiniku,
  (select count(*) from ind where label_id in (select label from t3)) as kakou,
  (select count(*) from ind where label_id in (select label from so union select label from se)) as sold,
  (select count(*) from ind where label_id in (select label from vo)) as voiced,
  (select count(*) from shipments) as shipments,
  (select count(*) from shipments where freight is not null) as shipments_with_freight,
  (select count(*) from ind where capture_lat is not null) as lat,
  (select count(*) from ind where age_estimate is not null) as age,
  (select count(*) from ind where body_length_cm is not null) as body_len,
  (select count(*) from ind where coalesce(bait_type,'') <> '') as bait,
  (select count(*) from ind where stomach_contents is not null and array_length(stomach_contents,1) > 0) as stomach;
```

## 11. 実行結果・提出物

### 提出物
- PR（Draft・merge しない）: https://github.com/okillcalco-bot/tateyama-gibier/pull/258
- base: `5bfaa47`（origin/main）／ head: PR #258 の最新コミット（第1版 ba145b1 → リベース → 第2版 7d9df88 → 本書の追記コミット）
- コード一式（差分・変更ファイル全文・関連コード。anon キーはマスク）: 提出時に tar.gz で別添

### E2E 全57本（main の #253〜#256 で3本増）の直列一括実行（第2版の最終コード・他のブラウザテストを並走させない）
- **52本 EXIT 0**。落ちた5本は §7 の既存ドリフト（`capture-ar-camera` / `capture-edit-from-list` / `capture-elderly-ui` /
  `capture-usual-flow` / `seika-ident-reuse`）で、**変更前の deed897 をそのまま取り出した worktree でも同じ失敗**を確認済み。
  `capture-form.html` は本変更で触っていない。`seika-ident-reuse` は 21/22（「ラベルが出たことも伝える」）で第1版以前から。
- 第1版の一括実行で並走のために落ちた `shipping-freight` / `stomach-contents` は、今回の直列実行では成功（フレークだった）。
- 変更した4本の結果（同じ一括実行内）: `individual-life` 27/27 / `direct-ship-freight` 33/33 / `base-ship-freight` 18/18 /
  `line-voice-and-shipment-link` 全PASS（EXIT 0）。

実行コマンド（1本ずつ）:
```
CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome NODE_PATH=/opt/node22/lib/node_modules /opt/node22/bin/node tests/e2e/<name>.e2e.js
```
