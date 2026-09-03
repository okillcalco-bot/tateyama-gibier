# 「1個体の一生」の線を太くする — 送料の空欄をなくす／一生ビューに出店と声をつなぐ — Codex レビュー依頼

軸（CLAUDE.md）: **生態 → 個体 → 精肉 → 加工 → 販売 → 食べた人の声 が1本の線で繋がっていること。**
今回はこの軸を変えず、実測で見つかった「線が切れている2か所」を直した。DBスキーマ変更なし、
マイグレーションなし、ジビエ基幹の既存テーブルへの書き込み経路も増やしていない。

## ブランチ / 差分

- ブランチ: `claude/alco-os-architecture-n56n5z`（ベース: `origin/main` = `15236e7`（PR #252 を含む）、0 behind）
- 変更ファイル（main 差分）:
  - `index.html` — 直販出荷の送料（届け先の地域・確定前ガード）、BASE出荷の送料自動入力、個体の一生ビュー（出店・声）
  - `tests/e2e/direct-ship-freight.e2e.js`（28件）/ `tests/e2e/base-ship-freight.e2e.js`（18件）/ `tests/e2e/individual-life.e2e.js`（26件）
  - `tests/e2e/line-voice-and-shipment-link.e2e.js`（#252 のテスト。声の取り方を RPC 経由に合わせた。下記「#252 との関係」）
  - `CLAUDE.md`（現状の実測値を 2026-09-03 に更新）
  - `docs/codex-review-line-freight-voice.md`（本書）
- 触っていないもの: `capture-form.html` / `order-admin.html` / `order-portal.html` / `s.html` / `sw.js` / `manifest.json` / `migrations/` / `alco-os/`

## まず測った（本番 `clpdyrehdgzgiidbfucj`・読み取りのみ・2026-09-03）

| 区間 | 08-26 基準 | 09-03 実測 | 見方 |
|---|---|---|---|
| 個体 | 600 | **634** | `individuals`（deleted_at null・AUTO-除く） |
| → 精肉 | 235 | **402** | `inventory.tier=2` を持つ個体 |
| → 加工 | — | **19** | `processing_log` → `inventory.tier=3` |
| → 販売 | 49 | **65**（注文64・出店11・出店のみ1） | `order_items→inventory` ＋ `sale_event_items.individual_label / member_labels` |
| → 声 | 0 | **0**（承認待ちも0） | `meal_voices` |
| 出荷の送料 | 27件中0 | **35件中0**（08-26以降の9件も0） | `shipments.freight` |
| 生態: 緯度経度/推定年齢/体長/餌/胃内容物 | 1/0/0/0/— | **1/0/8/0/0** | `individuals` 各列 |

### 切れていた場所と原因

1. **送料が1件も保存されていない（35/35）。** 08-24 に送料の自動計算（`tgc_compute_freight`・住所→都道府県→地域）と
   入力欄を入れたのに、その後の9件も全部空。直近の直販出荷の出荷先8件のうち**6件は顧客台帳に住所が無い**
   （エヴァーブルースカイ・Oobanburumai・はれとけ・館山美食倶楽部・燗むすび・自然の家 …）。
   コードは「住所が分からなければ自動計算を諦めて『直接入力してください』と出す」だけで、
   確定時は「未入力（あとで請求書に反映されません）」と**表示して通していた**。
   ＝ 同じ症状が3回どころか9回。対症療法（案内文）ではなく構造を変える。
2. **一生ビューの「こえ」が固定で「準備中」。** `meal_voices` / 物語ページ（s.html）/ 承認画面は #219〜#221 で完成しているのに、
   個体からたどる画面が最後の区間を表示していなかった。さらに「とどけた先」は `order_items` 経由だけを見ていて、
   **出店・直売会（`sale_event_items`）で売れた分**（11頭。うち1頭は出店でしか売れていない）が線に載っていなかった。

3. 精肉→販売の断絶（402→65）は業務側（在庫として保管中・加工に回る等）で、コードの欠陥ではない。今回は触らない。
   生態データ（体長8・胃内容物0）は入力欄が出来て日が浅い。次回の計測で見る。

## 変更1: 直販出荷の送料 — 住所が分からなくても「届け先の地域」から必ず出す

### 設計
- `shipping_rates` / `shipping_areas`（RLS無効・anon読取可。DBの `tgc_compute_freight` と同じ表）を端末に一度だけ読む。
- 送料の決め方を **2段** にした。
  1. 住所が分かる → 従来どおり DB の `tgc_compute_freight` を正とする（住所の都道府県から「届け先の地域」も自動選択）。
  2. 住所が分からない／DBで引けない → 画面の **「届け先の地域」**（既定 **関東**＝館山近郊の客が大半）で料金表から計算。
     仮置きであることを**画面に明示**し、違えば選び直せる。
- **確定時のガード**: 「発送」で送料が空なら確定直前にもう一度自動計算。それでも空なら**確定しない**（toast で理由と出口を示す:
  地域を選ぶ／金額を入れる／着払いは 0／送料が無い受け渡しは「手渡し・持ち帰り」）。
  「送料なしの発送」を黙って記録する経路を無くした。
- 手入力は常に最優先（自動計算中の手入力を古い結果で上書きしない仕組み＝`shipFreightSeq` は従来どおり）。

### コード（index.html）

HTML（直販出荷の配送欄。運送会社の隣に「届け先の地域」を追加）:
```html
<div class="form-group" style="margin:0;min-width:120px;"><label>運送会社</label>
  <select class="form-input" id="ship-direct-carrier" onchange="shipDirectCarrierChange()">
    <option value="ヤマト">ヤマト運輸</option><option value="佐川">佐川急便</option>
  </select>
</div>
<!-- 届け先の地域。住所が分かれば自動で選ばれ、分からなければ関東（館山近郊）を仮置きして送料を出す。
     ＝「住所不明→送料が空のまま保存」を無くす（出荷35件中0件が送料入りだった） -->
<div class="form-group" style="margin:0;min-width:110px;"><label>届け先の地域</label>
  <select class="form-input" id="ship-direct-area" onchange="shipDirectFreightAuto(true)">
    <option value="関東" selected>関東</option>
  </select>
</div>
```

料金表の読み込みと計算（新規）:
```js
let shipRatesCache = null;      // [{carrier, area, size_code, base_fee, cool_surcharge}]
let shipAreasCache = null;      // [{carrier, pref, area}]
const SHIP_DEFAULT_AREA = '関東';   // 館山近郊のお客様が大半。住所不明時の仮置き（画面で明示する）
async function shipLoadRates() {
  if (shipRatesCache) return shipRatesCache;
  try {
    const [rates, areas] = await Promise.all([
      sb('GET', 'shipping_rates', null, '?select=carrier,area,size_code,base_fee,cool_surcharge&limit=500'),
      sb('GET', 'shipping_areas', null, '?select=carrier,pref,area&limit=200')
    ]);
    shipRatesCache = Array.isArray(rates) ? rates : [];
    shipAreasCache = Array.isArray(areas) ? areas : [];
  } catch (e) {
    shipRatesCache = []; shipAreasCache = [];
  }
  return shipRatesCache;
}
// 住所文字列 → 都道府県（DB側 tgc_addr_pref と同じ規則）
function shipAddrPref(addr) {
  const m = String(addr || '').match(/(東京都|北海道|京都府|大阪府|[一-龠]{2,3}県)/);
  return m ? m[1] : '';
}
// 運送会社ごとの地域一覧（料金表にある順）。読み込み前は関東だけ
function shipAreasFor(carrier) {
  const seen = new Set(), out = [];
  (shipRatesCache || []).forEach(r => { if (r.carrier === carrier && !seen.has(r.area)) { seen.add(r.area); out.push(r.area); } });
  return out.length ? out : [SHIP_DEFAULT_AREA];
}
// 住所から地域を引く（その運送会社の区分で）。分からなければ ''
function shipAreaFromAddress(addr, carrier) {
  const pref = shipAddrPref(addr);
  if (!pref) return '';
  const hit = (shipAreasCache || []).find(a => a.carrier === carrier && a.pref === pref);
  return hit ? hit.area : '';
}
// 料金表から送料（税抜）。無ければ null。クール便で追加料金が無いサイズ（140以上）は null＝要手入力
function shipRateFromTable(carrier, area, size, cool) {
  const r = (shipRatesCache || []).find(x => x.carrier === carrier && x.area === area && Number(x.size_code) === Number(size));
  if (!r) return null;
  if (cool) return r.cool_surcharge == null ? null : Number(r.base_fee) + Number(r.cool_surcharge);
  return Number(r.base_fee);
}
// 「届け先の地域」の選択肢を運送会社に合わせて作り直す（選択中の地域はできるだけ残す）
function shipDirectFillAreaOptions(keepArea) {
  const sel = document.getElementById('ship-direct-area');
  if (!sel) return;
  const carrier = document.getElementById('ship-direct-carrier')?.value || 'ヤマト';
  const areas = shipAreasFor(carrier);
  const want = keepArea || sel.value || SHIP_DEFAULT_AREA;
  sel.innerHTML = areas.map(a => `<option value="${esc2(a)}">${esc2(a)}</option>`).join('');
  sel.value = areas.includes(want) ? want : (areas.includes(SHIP_DEFAULT_AREA) ? SHIP_DEFAULT_AREA : areas[0]);
}
function shipDirectCarrierChange() {
  shipDirectFillAreaOptions();
  shipDirectFreightAuto(true);
}
```

自動計算（置換。①住所→DB計算 ②地域→料金表 の2段）:
```js
async function shipDirectFreightAuto(force) {
  const note = document.getElementById('ship-direct-freight-note');
  const fEl = document.getElementById('ship-direct-freight');
  if (!fEl || document.getElementById('ship-direct-method')?.value !== '発送') return;
  if (!force && fEl.value) return;              // 手入力済みは尊重する
  const name = (document.getElementById('ship-direct-cust')?.value || '').trim();
  const addr = shipCustAddrMap[name] || '';
  const opts = {
    carrier: document.getElementById('ship-direct-carrier').value,
    size: parseInt(document.getElementById('ship-direct-size').value, 10),
    cool: document.getElementById('ship-direct-cool').checked
  };
  const seq = ++shipFreightSeq;
  if (note) note.textContent = '計算中…';
  await shipLoadRates();
  if (seq !== shipFreightSeq) return;
  shipDirectFillAreaOptions();
  const areaSel = document.getElementById('ship-direct-area');

  // ① 住所が分かる → 住所の都道府県から地域を決め、DBの料金計算（tgc_compute_freight）を正とする
  let v = null, basis = '';
  if (addr) {
    const area = shipAreaFromAddress(addr, opts.carrier);
    if (area && areaSel) shipDirectFillAreaOptions(area);
    v = await shipComputeFreight(addr, opts);
    if (seq !== shipFreightSeq) return;
    if (v == null && area) v = shipRateFromTable(opts.carrier, area, opts.size, opts.cool);
    basis = `${esc2(name)} の住所（${esc2(shipAddrPref(addr) || '都道府県不明')}）から算出`;
  }
  // ② 住所が分からない／料金表で引けない → 画面の「届け先の地域」で計算する（既定は関東）
  if (v == null) {
    const area = areaSel ? areaSel.value : SHIP_DEFAULT_AREA;
    v = shipRateFromTable(opts.carrier, area, opts.size, opts.cool);
    basis = addr
      ? `届け先の地域「${esc2(area)}」で算出`
      : `<span style="color:var(--gold)">住所が分からないため、届け先の地域「${esc2(area)}」で算出しました。違う地域なら選び直してください。</span>`;
  }
  if (seq !== shipFreightSeq) return;
  if (v == null) {
    fEl.value = '';
    if (note) note.innerHTML = `<span style="color:var(--gold)">${esc2(opts.carrier)} ${opts.size}サイズ${opts.cool ? '・クール' : ''}は料金表にありません（クール便は120サイズまで）。送料を直接入力してください。</span>`;
    return;
  }
  fEl.value = v;
  if (note) note.innerHTML = `${basis} → <b style="color:var(--gold)">¥${v.toLocaleString()}</b>（税抜・${esc2(opts.carrier)} ${opts.size}サイズ${opts.cool ? '・クール' : ''}）`;
}
```

確定前ガード（`shipDirectConfirm` 冒頭の確認文を作る部分を置換）:
```js
if (_dm === '発送') {
  // 送料が空なら、確定の直前にもう一度だけ自動計算する（住所不明でも地域から出る）。
  // それでも空なら確定しない＝「送料なしの発送」を黙って記録しない
  let _fv = parseInt(document.getElementById('ship-direct-freight').value, 10);
  if (!(isFinite(_fv) && _fv >= 0)) {
    await shipDirectFreightAuto(true);
    _fv = parseInt(document.getElementById('ship-direct-freight').value, 10);
  }
  if (!(isFinite(_fv) && _fv >= 0)) {
    toast('送料が空です。「届け先の地域」を選ぶか送料を入力してください（着払いなら 0、送料が無い受け渡しなら「手渡し・持ち帰り」を選択）', 'error');
    document.getElementById('ship-direct-freight')?.focus();
    return;
  }
  const _cr = document.getElementById('ship-direct-carrier').value;
  const _sz = document.getElementById('ship-direct-size').value;
  const _cl = document.getElementById('ship-direct-cool').checked ? '・クール' : '';
  const _ar = document.getElementById('ship-direct-area')?.value || '';
  _dl = `受け渡し: 発送（${_cr} ${_sz}サイズ${_cl}${_ar ? '・' + _ar : ''}）\n送料: ¥${_fv.toLocaleString()}（税抜）`;
}
```
保存本体（`shipBody.freight` を `isFinite(fv) && fv >= 0` のときだけ入れる）は変えていない。

## 変更2: BASE注文の発送 — 購入者の都道府県から送料を先に入れておく

BASEの注文情報（`base_order_detail` → `order.prefecture`）は必ず都道府県を持つ。カード描画時に
`baseFreightAuto(key, false)` で送料を埋め、運送会社・サイズ・クールの変更で再計算。発送処理の直前にも空なら再計算。
**BASE経路は従来どおり「それでも空なら記録だけ進める」**（料金表が読めない環境で発送が止まらないように。テストで固定）。

```js
async function baseFreightAuto(key, force) {
  const fEl = document.getElementById('base-freight-' + key);
  const note = document.getElementById('base-freight-note-' + key);
  if (!fEl) return null;
  if (!force && fEl.value) return parseInt(fEl.value, 10);
  const od = baseOrderCache[key] || {};
  const carrier = document.getElementById('base-carrier-' + key)?.value || 'ヤマト';
  const size = parseInt(document.getElementById('base-size-' + key)?.value || '100', 10);
  const cool = !!document.getElementById('base-cool-' + key)?.checked;
  await shipLoadRates();
  const pref = shipAddrPref(od.prefecture || od.address || '');
  const areaFromPref = pref ? shipAreaFromAddress(pref, carrier) : '';
  const area = areaFromPref || SHIP_DEFAULT_AREA;
  const v = shipRateFromTable(carrier, area, size, cool);
  if (v == null) {
    fEl.value = '';
    if (note) note.innerHTML = `<span style="color:var(--gold)">${esc2(carrier)} ${size}サイズ${cool ? '・クール' : ''}は料金表にありません。送料を直接入力してください。</span>`;
    return null;
  }
  fEl.value = v;
  if (note) note.innerHTML = areaFromPref
    ? `届け先 ${esc2(pref)}（${esc2(area)}）→ <b style="color:var(--gold)">¥${v.toLocaleString()}</b>（税抜・${esc2(carrier)} ${size}${cool ? '・クール' : ''}）`
    : `<span style="color:var(--gold)">届け先の都道府県が取れないため、関東で算出 ¥${v.toLocaleString()}（税抜）。違えば送料を直してください。</span>`;
  return v;
}
```
`baseOrderShip` の確認文を作る直前:
```js
let _fv = _fEl ? parseInt(_fEl.value, 10) : NaN;
if (!(isFinite(_fv) && _fv >= 0)) { await baseFreightAuto(key, true); _fv = _fEl ? parseInt(_fEl.value, 10) : NaN; }
```

注文経由の出荷（`shipOrderConfirmed`）は `orders.delivery_address` から従来どおりDB計算。今回は触っていない
（住所が空の注文は注文ポータル側の必須項目なので実データでは起きていない。今後の計測で見る）。

## 変更3: 個体の一生ビュー — 「とどけた先」に出店を載せ、「こえ」を本物につなぐ

### 取得（`indLifeOpen` に追加）
```js
// 出店・直売会で売れた分（注文を通らない販売）。この個体が単独で載った品と、ブレンド品の一員として載った品
let eventItems = [], events = [];
try {
  eventItems = await sb('GET', 'sale_event_items', null,
    `?or=(individual_label.eq.${enc},member_labels.cs.{${enc}})&select=id,event_id,kind,item_name,part_name,qty_taken,qty_sold,qty_sample,amount,member_labels&order=created_at.asc`) || [];
  const evIds = [...new Set(eventItems.map(x => x.event_id).filter(Boolean))];
  if (evIds.length) {
    events = await sb('GET', 'sale_events', null, `?id=in.(${evIds.join(',')})&deleted_at=is.null&select=id,event_date,venue_name,title,status`) || [];
  }
} catch (e) {}

// 食べた人の声。公開済みは物語ページと同じRPC（story_get_individual）、承認待ちは職員用RPCから件数だけ
let voices = [], pendingVoices = 0;
try {
  const story = await sb('POST', 'rpc/story_get_individual', { p_label: labelId });
  voices = (story && Array.isArray(story.voices)) ? story.voices : [];
} catch (e) {}
try {
  const pend = await sb('POST', 'rpc/staff_voices_list', { p_status: 'pending', p_limit: 500 }) || [];
  pendingVoices = pend.filter(v => v.individual_label === labelId).length;
} catch (e) {}

indLifeData = { ind, parts, logs, batchCodes, packs, items, orders, custs, eventItems, events, voices, pendingVoices };
```
- `meal_voices` は RLS が deny-all（public）のため直接は読まず、**既存RPCだけ**を使う。
  公開済み＝物語ページ（s.html）が見せているものと**同じ関数**の結果なので、画面間で食い違わない。
- 承認待ちの件数は `staff_voices_list('pending')` を個体番号で絞る（新RPCを作らない。声は現状0件で、500件上限は当面十分。
  増えたら個体別RPCに置き換える）。
- RPCが無い／失敗しても一生ビュー全体は落ちない（各取得を個別に try/catch。テストで404を流して確認）。

### 描画（`indLifeRender`）
- 段階インジケータ: `とどけた` は注文 or 出店があれば点灯、サブに「n件・出店m回」。`こえ` は公開済みがあれば点灯、
  サブに「n件（待ちk）」。固定の「準備中」を廃止。
- とどけた先の表に出店の行を追加（🏕 会場 / 品名（n頭のブレンド）/ 売れた数/持出数 / 開催日）。
- 声の節: 公開済みの声を名前・★・料理・本文・日付で列挙。承認待ちがあれば件数と「💬 食べた人の声で確認する」ボタン
  （`indLifeGoVoices()`＝モーダルを閉じて声タブへ）。0件なら「QRから残せる／承認すると出る」の案内。

```js
function indLifeGoVoices() {
  const modal = document.getElementById('indLifeModal');
  if (modal) modal.style.display = 'none';
  const btn = document.querySelector('.tab-btn[data-tab="voices"]');
  if (btn) btn.click();
}
```

## #252（同日に main へ入った別セッションの変更）との関係

PR #252「一頭の線を末端まで通す」が同じ `index.html` の一生ビューと直販確定を触っていたため、その上にリベースした。

- 直販確定: #252 は書き込みを `recordDirectShipment()` に共通化。本変更の「確定前ガード」はその手前（確認文を作る所）に
  入るので衝突せず、`delivery.freight` の組み立ても #252 のまま。手動「出荷済」（`changeStatus`）経路は送料を持たない
  （注文なし・手渡し相当）ので今回は触っていない。
- 一生ビューの声: #252 は `meal_voices` を **画面から直接 GET** していたが、本番の `meal_voices` は
  `meal_voices_deny`（public / ALL / `USING false`）の RLS で **anon からは常に0件が静かに返る**（エラーにならない）。
  そのため、物語ページ（s.html）と同じ `story_get_individual`（SECURITY DEFINER・公開済みのみ）と、
  職員用の `staff_voices_list('pending')`（承認待ち件数）で引く本変更側を採用した。
  未公開の本文は一生ビューに出さず件数と行き先（声タブ）だけにする＝「承認してから公開」（#221）の建付けを崩さない。
  #252 の E2E（`line-voice-and-shipment-link`）の③をこの取り方に合わせて書き換えた（`meal_voices` を直接読まないことも確認）。
- ラベルQR・出荷先必須（#252 の①②）はそのまま。

## テスト

| ファイル | 件数 | 主な確認 |
|---|---|---|
| `direct-ship-freight.e2e.js` | 28/28 | 住所あり→DB計算1500・地域も自動選択／住所なし→関東で1300と「仮定」の明示／地域選び直し1600／運送会社変更で地域保持＋区分の選択肢／料金表に無い組合せは空欄＋案内／計算中の手入力を上書きしない／**空のまま確定→直前に自動計算して1300を保存**／**出せないまま空なら確定しない（POSTなし・ボタンは押せるまま）**／手渡しは送料なし |
| `base-ship-freight.e2e.js` | 18/18 | 大阪府→関西で1600を先に入れる・根拠表示／条件変更で再計算／手入力が優先／空のまま発送→直前に自動計算／料金表が読めなければ従来どおり記録は通る |
| `individual-life.e2e.js` | 26/26 | 出店の行（会場・品名・7/40個・11頭のブレンド）／段階「とどけた」に出店1回／問い合わせが `individual_label.eq` と `member_labels.cs` の両方／声が `story_get_individual` から出る／承認待ちはこの個体の分だけ1件／段階「こえ」1件（待ち1）／「準備中」が消えた／ボタンで声タブへ／販売・声なしでも壊れない／RPC 404でも一生ビューは出る |

全E2E（tests/e2e/ 54本）の結果は末尾「実行結果」に記載。

## 制約の遵守

- 本番DBへの書き込みなし（計測は SELECT のみ）。マイグレーションなし。
- `individuals` / `inventory` / `orders` / `shipments` の**書き込み内容は変えていない**（`shipments.freight` に入る値が「空」から「計算値」になるだけ）。
- 既存の手入力・上書き防止・手渡し（送料なし）の挙動は既存テストのまま。
- 一生ビューは読み取り専用のまま（新しい書き込み経路なし）。
- 触っていないPWA資産: `sw.js` / `manifest.json`。`index.html` の変更は関数追加と3か所の置換のみ。

## 判断を仰ぎたい点（勝手に決めていないこと）

1. **住所不明時の仮置きを「関東」にした。** 館山近郊の顧客が大半という前提。画面で「仮定」と明示し選び直せるが、
   関西などへ送るときに気づかず確定する可能性はある（従来は「空」だったので、間違った金額 vs 空欄 のトレードオフ）。
   仮置きをやめて「地域を必ず選ばせる（未選択なら確定不可）」にもできる。運用で決めてほしい。
2. **直販の「発送」で送料が空なら確定しない**ようにした。出口は用意した（地域選択／金額／着払い0／手渡し）。
   現場で止まる場面があれば緩める。
3. 過去35件の出荷の送料は**追記していない**（元データは書き換えない方針）。必要なら `shipments.carrier/size_code/is_cool` が
   入っている6件（08-28〜09-01・ヤマト100クール）は料金表から埋められる。

## 見送ったもの（次回以降）

- 注文経由の出荷（`shipOrderConfirmed`）への地域フォールバック（実データで住所空が出ていないため）。
- 声の個体別RPC（`staff_voices_list('pending')` のクライアント絞り込みで足りる規模）。
- 既存の壊れているE2E 3本（下記）は `capture-form.html` 側のテストのドリフトで、本変更と無関係。別PRで直す。

## 実測SQL（次回の計測用・読み取りのみ）

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

## 実行結果

実行コマンド（1本ずつ）:
```
CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome NODE_PATH=/opt/node22/lib/node_modules /opt/node22/bin/node tests/e2e/<name>.e2e.js
```

- リベース後（origin/main 15236e7 の上）の最終コードで再実行:
  `direct-ship-freight` **28/28** / `base-ship-freight` **18/18** / `individual-life` **26/26** /
  `line-voice-and-shipment-link` **18/18** / `label-layout-overlap` **19/19** / `shipping-freight` **6/6** / `stomach-contents` **19/19**
- 全54本の一括実行（リベース前のコード・直列実行）: **47本 EXIT 0**。落ちた7本の内訳:
  - 変更と無関係（**変更前の deed897 をそのまま取り出した worktree でも同じ失敗**）: `capture-ar-camera` / `capture-edit-from-list` /
    `capture-elderly-ui` / `capture-usual-flow`（`capture-form.html` のテスト。当日番号の連番・体長入力・?staff= 画面・端末DL判定）と
    `seika-ident-reuse`（21/22。「ラベルが出たことも伝える」）。別PRで直す。
  - 一括実行中だけ落ちた（同時に別のブラウザテストを走らせていた）: `shipping-freight` / `stomach-contents` → 単独では上記のとおり全件成功。
    clean な origin/main でも単独で全件成功（フレーク）。
