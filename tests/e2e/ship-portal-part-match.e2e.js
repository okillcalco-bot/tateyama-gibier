// 出荷処理: ポータルの注文（明細名が商品名「猪バラ」等）に在庫を割り当てられる（2026-10-22 沖「注文入ってるのの割り当てが変。個別で割り当てられない」）
//
//   きっかけ
//     ポータルから入った注文（猪ロース・猪タン（舌）・猪カタ（ウデ）・猪バラ）に、バラ・ロースのパックを読むと
//     「部位が一致しません」で全部弾かれ、行ごとのドロップダウンも空だった。
//     比べ方が「明細名＝部位名」「部位名が明細名を含む」だけで、ポータルの明細名は商品名（猪〜・（舌）・（上）…）のため。
//     逆に「ロース」の行に「肩ロース」のパックが当たってしまう穴もあった（「肩ロース」は「ロース」を含む）。
//
//   ここで測ること
//     1. ポータル全55商品について、商品→部位の正本（portal_product_parts）に載っている部位はすべて当てられる
//        （部位の載っていない等級違い（上）（極上）は、並の商品と同じ部位が当てられる）
//     2. 別の部位は当たらない（ロース↔肩ロース、カタ↔肩ロース、モモ↔ミンチ…を全組み合わせで）
//     3. スキャン: 猪バラ・猪ロース・猪カタ（ウデ）・猪タン（舌）の行に、バラ・ロース・カタ・タンのパックが入る。肩ロースは弾く
//     4. ドロップダウン: 各行に合う在庫が出る（ロースの行に肩ロースは出ない）。合う在庫が無ければ「在庫なし（…）」と書く
//     5. 中型獣（キョン（一頭分・ご希望））の行に キョンの枝肉が当たる
//     6. 手入力の行: これまで当たっていたもの（枝肉←枝肉（全体）、バラ←骨付き バラ…）は当たり続け、
//        誤りだったもの（ロース←肩ロース、骨←骨付き バラ）は当たらない。「枝肉（上）」「骨付き バラ」の行は他を拾わない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

// portal_products × portal_product_parts（2026-10-22 時点の全55商品。公開している商品名と部位名だけ）
const CATALOG = [
  ['イノシシ', 'ミンチ原料用', ['ミンチ用']], ['イノシシ', '内部用途（味肉用）', ['味肉用']], ['イノシシ', '希少部位（チチカブ）', ['チチカブ']],
  ['イノシシ', '猪カタ（ウデ）', ['カタ', 'カタ（ウデ）']], ['イノシシ', '猪カタ（ウデ）（上）', []], ['イノシシ', '猪カタ（ウデ）（極上）', []],
  ['イノシシ', '猪スネ', ['スネ']], ['イノシシ', '猪スネ（上）', []], ['イノシシ', '猪スネ（極上）', []],
  ['イノシシ', '猪タン（舌）', ['タン（舌）']], ['イノシシ', '猪チレ（脾臓）', ['チレ（脾臓）']],
  ['イノシシ', '猪ネック', ['ネック']], ['イノシシ', '猪ネック（上）', []], ['イノシシ', '猪ネック（極上）', []],
  ['イノシシ', '猪ハツ（心臓）', ['ハツ（心臓）']],
  ['イノシシ', '猪バラ', ['バラ']], ['イノシシ', '猪バラ（上）', []], ['イノシシ', '猪バラ（極上）', []],
  ['イノシシ', '猪ヒレ', ['ヒレ']], ['イノシシ', '猪ヒレ（上）', []], ['イノシシ', '猪ヒレ（極上）', []],
  ['イノシシ', '猪フワ（肺）', ['フワ（肺）']],
  ['イノシシ', '猪ペットフード・骨あり', ['ペットフード用（あり）']], ['イノシシ', '猪ペットフード・骨なし', ['ペットフード用（なし）']],
  ['イノシシ', '猪マメ（腎臓）', ['マメ（腎臓）']], ['イノシシ', '猪ミンチ用（上）', []], ['イノシシ', '猪ミンチ用（極上）', []],
  ['イノシシ', '猪モモ（上）', []], ['イノシシ', '猪モモ（極上）', []], ['イノシシ', '猪レバ（肝臓）', ['レバ（肝臓）']],
  ['イノシシ', '猪ロース', ['ロース']], ['イノシシ', '猪ロース（上）', []], ['イノシシ', '猪ロース（極上）', []],
  ['イノシシ', '猪枝肉（一頭分・ご希望）', ['枝肉（全体）']], ['イノシシ', '猪粗挽きミンチ', ['ミンチ肉（粗挽き）']],
  ['イノシシ', '猪肩ロース', ['肩ロース']], ['イノシシ', '猪肩ロース（上）', []], ['イノシシ', '猪肩ロース（極上）', []],
  ['イノシシ', '猪赤つなぎセット', ['赤つなぎセット']], ['キョン', 'キョン商品（ロース）', ['ロース']],
  ['シカ', '鹿カタ（ウデ）', ['カタ']], ['シカ', '鹿スネ', ['スネ']], ['シカ', '鹿ネック', ['ネック']], ['シカ', '鹿バラ', ['バラ']],
  ['シカ', '鹿ヒレ', ['ヒレ']], ['シカ', '鹿ミンチ', ['ミンチ用']], ['シカ', '鹿モモ', ['モモ（ウチ）', 'モモ（シンタマ）', 'モモ（ソト）']],
  ['シカ', '鹿ロース', ['ロース']], ['シカ', '鹿枝肉（一頭分・ご希望）', []], ['シカ', '鹿肩ロース', ['肩ロース']],
  ['中型獣', 'アライグマ（一頭分・ご希望）', []], ['中型獣', 'キョン（一頭分・ご希望）', []], ['中型獣', 'タヌキ（一頭分・ご希望）', []],
  ['中型獣', 'ノウサギ（一頭分・ご希望）', []], ['中型獣', 'ハクビシン（一頭分・ご希望）', []],
];
// 部位の載っていない商品が当てる部位（並の商品・一頭分は枝肉）
const BASE_OF = n => {
  if (/（一頭分・ご希望）$/.test(n)) return ['枝肉（全体）'];
  const base = n.replace(/（(上|極上)）$/, '');
  const hit = CATALOG.find(c => c[1] === base && c[2].length);
  if (hit) return hit[2];
  return [base.replace(/^猪/, '')];   // 猪モモ（上）→ モモ、猪ミンチ用（上）→ ミンチ用
};
// 在庫に実際にある部位名（2026-10-22 の在庫表の部位名の種類。ラベルの書き方の揺れを含む）
const INV_PARTS = ['カタ', 'スネ', 'タン', 'チチカブ', 'ネック', 'ハツ', 'バラ', 'バラ [小売]', 'ヒレ', 'フワ', 'ペットフード用（あり）', 'ペットフード用（なし）',
  'ミンチ用', 'ミンチ肉（粗挽き）', 'モモ（ウチ）', 'モモ（シンタマ）', 'モモ（ソト）', 'モモ（全体）', 'モモ（全体） [小売]', 'レバー', 'ロース', 'ロース [小売]',
  '味肉用', '唐揚げ用', '枝肉（全体）', '枝肉（下）', '肩ロース', '肩ロース [小売]', '骨付き バラ', '骨付きバラ', '骨付バラ', 'スライス肉（3mm）', 'スライス用'];

(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9141);
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const out = []; const ck = (n, c, e) => out.push([n, !!c, e == null ? '' : String(e)]);
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));

  // DBのかわり（ポータル注文1件）
  const ORDER = { id: 'o1', order_code: 'ORD-PORTAL', customer_name: 'テスト食堂', status: '確認済', channel: 'portal', delivery_date: null };
  let items = [
    { id: 'l-ro', order_id: 'o1', species: 'イノシシ', part_name: '猪ロース', product_name: '猪ロース', product_id_v2: 'pp1', weight: 2, weight_kg: 2, requested_kg: 2, unit_price: 3800, subtotal: 7600, inventory_id: null },
    { id: 'l-tan', order_id: 'o1', species: 'イノシシ', part_name: '猪タン（舌）', product_name: '猪タン（舌）', product_id_v2: 'pp2', weight: 2, weight_kg: 2, requested_kg: 2, unit_price: 1000, subtotal: 2000, inventory_id: null },
    { id: 'l-kata', order_id: 'o1', species: 'イノシシ', part_name: '猪カタ（ウデ）', product_name: '猪カタ（ウデ）', product_id_v2: 'pp3', weight: 0.5, weight_kg: 0.5, requested_kg: 0.5, unit_price: 2200, subtotal: 1100, inventory_id: null },
    { id: 'l-ba', order_id: 'o1', species: 'イノシシ', part_name: '猪バラ', product_name: '猪バラ', product_id_v2: 'pp4', weight: 1, weight_kg: 1, requested_kg: 1, unit_price: 3100, subtotal: 3100, inventory_id: null },
    { id: 'l-kyon', order_id: 'o1', species: '中型獣', part_name: 'キョン（一頭分・ご希望）', product_name: 'キョン（一頭分・ご希望）', product_id_v2: 'pp5', weight: null, weight_kg: null, requested_kg: null, unit_price: null, subtotal: 0, inventory_id: null },
  ];
  const INV = [
    { id: 'v-ba', ident_code: 'TGC-08-T901-BA-3', scan_code: '19000001', part_name: 'バラ', weight: 0.23, weight_kg: 0.23, individual_id: 'TGC-08-T901', species: 'イノシシ', status: '在庫' },
    { id: 'v-ro', ident_code: 'TGC-08-T902-RO', scan_code: '19000002', part_name: 'ロース', weight: 1.14, weight_kg: 1.14, individual_id: 'TGC-08-T902', species: 'イノシシ', status: '在庫' },
    { id: 'v-kr', ident_code: 'TGC-08-T903-KR', scan_code: '19000003', part_name: '肩ロース', weight: 0.8, weight_kg: 0.8, individual_id: 'TGC-08-T903', species: 'イノシシ', status: '在庫' },
    { id: 'v-ka', ident_code: 'TGC-08-T904-KA', scan_code: '19000004', part_name: 'カタ', weight: 0.62, weight_kg: 0.62, individual_id: 'TGC-08-T904', species: 'イノシシ', status: '在庫' },
    { id: 'v-tan', ident_code: 'OG-261020-01', scan_code: '19000005', part_name: 'タン', weight: 0.99, weight_kg: 0.99, individual_id: null, species: 'イノシシ', status: '在庫' },
    { id: 'v-kyon', ident_code: 'TGC-08-K901', scan_code: '19000006', part_name: '枝肉（全体）', weight: 6.5, weight_kg: 6.5, individual_id: 'TGC-08-K901', species: 'キョン', status: '在庫' },
    { id: 'v-deer', ident_code: 'TGC-08-S901-RO', scan_code: '19000007', part_name: 'ロース', weight: 0.7, weight_kg: 0.7, individual_id: 'TGC-08-S901', species: 'シカ', status: '在庫' },
  ];
  let seq = 0;
  await p.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, st) => rt.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
    const body = () => JSON.parse(req.postData() || '{}');
    if (/\/order_items/.test(url)) {
      if (m === 'GET') {
        if (/inventory_id=eq\./.test(url)) { const id = url.match(/inventory_id=eq\.([^&]+)/)[1]; return J(items.filter(i => i.inventory_id === id)); }
        if (/order_id=eq\.o1/.test(url)) return J(items.map(i => ({ ...i })));
        return J([]);
      }
      if (m === 'PATCH') { const id = url.match(/id=eq\.([^&]+)/)[1]; const bd = body(); items = items.map(i => i.id === id ? { ...i, ...bd } : i); return J([]); }
      if (m === 'POST') { const bd = body(); const row = { id: 'n' + (++seq), ...bd }; items.push(row); return J([row], 201); }
    }
    if (/\/orders/.test(url)) {
      if (m === 'GET') return J([ORDER]);
      if (m === 'PATCH') { Object.assign(ORDER, body()); return J([]); }
    }
    if (/\/inventory/.test(url)) {
      if (m === 'PATCH') { const id = url.match(/id=eq\.([^&]+)/)[1]; const bd = body(); INV.forEach(x => { if (x.id === id) Object.assign(x, bd); }); return J([]); }
      const sc = url.match(/scan_code=eq\.(\d+)/);
      if (sc) return J(INV.filter(x => x.scan_code === sc[1]));
      const ids = (url.match(/[?&]id=in\.\(([^)]+)\)/) || [])[1];
      if (ids) return J(INV.filter(x => ids.split(',').includes(x.id)).map(x => ({ id: x.id, ident_code: x.ident_code })));
      return J(INV.filter(x => x.status === '在庫'));
    }
    if (/\/individuals/.test(url)) return J(INV.filter(x => x.individual_id).map(x => ({ label_id: x.individual_id, species: x.species })));
    return J([]);
  });
  await p.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await p.goto('http://localhost:9141/index.html'); await p.waitForTimeout(700);
  await p.evaluate(() => { window.__toasts = []; window.toast = (msg, type) => window.__toasts.push({ msg, type }); window.playFeedbackSound = () => {}; });

  // 1・2. 照合の全件（正本の対応表 × 在庫の部位名）
  const has = await p.evaluate(() => typeof shipPartOk === 'function');
  ck('照合の関数がある（shipPartOk）', has, '');
  if (has) {
    const res = await p.evaluate(([cat, invParts, baseSrc]) => {
      const BASE_OF = eval(baseSrc);
      const miss = [], wrong = [];
      for (const [sp, name, parts] of cat) {
        const want = parts.length ? parts : BASE_OF(name);
        for (const part of want) if (!shipPartOk(part, name)) miss.push(`${name} ← ${part}`);
        // 他の商品の部位（親子関係でないもの）は当たらない
        for (const [sp2, name2, parts2] of cat) {
          if (sp2 !== sp || name2 === name) continue;
          const want2 = parts2.length ? parts2 : BASE_OF(name2);
          for (const q of want2) {
            if (want.includes(q)) continue;                              // 同じ部位を持つ（等級違い・言い換え）
            if (want.some(w => q.startsWith(w + '（'))) continue;        // 親子（モモ ⊃ モモ（ソト））
            if (shipPartOk(q, name)) wrong.push(`${name} ← ${q}（${name2} の部位）`);
          }
        }
      }
      // 在庫に実際にある部位名ごとに、当たる商品
      const byInv = {};
      for (const ip of invParts) byInv[ip] = cat.filter(([sp, name]) => sp === 'イノシシ' && shipPartOk(ip, name)).map(c => c[1]);
      return { miss, wrong, byInv, n: cat.length };
    }, [CATALOG, INV_PARTS, BASE_OF.toString().replace('CATALOG', JSON.stringify(CATALOG))]);
    ck(`正本の対応表の全${res.n}商品で、載っている部位がすべて当たる`, res.n === 55 && res.miss.length === 0, res.miss.join(' / '));
    ck('別の商品の部位は当たらない（全組み合わせ）', res.wrong.length === 0, res.wrong.slice(0, 12).join(' / '));
    const bi = res.byInv;
    ck('在庫「ロース」は 猪ロース 系だけ（猪肩ロースには当たらない）', bi['ロース'].every(n => /^猪ロース/.test(n)) && bi['ロース'].length === 3, bi['ロース'].join(','));
    ck('在庫「肩ロース」は 猪肩ロース 系だけ（猪ロースには当たらない）', bi['肩ロース'].every(n => /^猪肩ロース/.test(n)) && bi['肩ロース'].length === 3, bi['肩ロース'].join(','));
    ck('ラベルの書き方の揺れ（タン・レバー・骨付き バラ・骨付バラ・バラ [小売]）も当たる',
      bi['タン'].includes('猪タン（舌）') && bi['レバー'].includes('猪レバ（肝臓）') && ['骨付き バラ', '骨付きバラ', '骨付バラ', 'バラ [小売]'].every(x => bi[x].includes('猪バラ')), JSON.stringify({ タン: bi['タン'], レバー: bi['レバー'], 骨付バラ: bi['骨付バラ'] }));
    ck('モモの等級品（猪モモ（上））には モモ（ウチ・シンタマ・ソト・全体）が当たる', ['モモ（ウチ）', 'モモ（シンタマ）', 'モモ（ソト）', 'モモ（全体）'].every(x => bi[x].includes('猪モモ（上）')), '');
    ck('一頭分（枝肉（全体））に 枝肉（下）は当たらない', !bi['枝肉（下）'].length && bi['枝肉（全体）'].includes('猪枝肉（一頭分・ご希望）'), JSON.stringify(bi['枝肉（下）']));
    ck('どの商品にも無い部位（唐揚げ用・スライス肉）は当たらない', !bi['唐揚げ用'].length && !bi['スライス肉（3mm）'].length && !bi['スライス用'].length, '');
    // 手入力の行（受発注管理・直販で打った部位名）。これまで当たっていたものは当たり続け、誤りだったものは当たらない
    const typed = await p.evaluate(() => ({
      edaUpper: shipPartOk('枝肉（全体）', '枝肉（上）') || shipPartOk('枝肉（下）', '枝肉（上）'),
      edaUpperSelf: shipPartOk('枝肉（上）', '枝肉（上）'),
      eda: shipPartOk('枝肉（全体）', '枝肉') && shipPartOk('枝肉（下）', '枝肉'),
      boneLinePlain: shipPartOk('バラ', '骨付き バラ'),
      boneLineBone: shipPartOk('骨付バラ', '骨付き バラ') && shipPartOk('ロース骨付', '骨付きロース'),
      plainLineBone: shipPartOk('骨付き バラ', 'バラ'),
      hone: shipPartOk('骨付き バラ', '骨') || shipPartOk('骨付き モモ（全体）', '骨'),
      old: shipPartOk('上ロース', 'ロース') && shipPartOk('内モモ', 'モモ（ウチ）') && shipPartOk('ペットフード用（あり）', 'ペットフード用') && shipPartOk('ミンチ肉（粗挽き）', 'ミンチ'),
    }));
    ck('手入力「枝肉（上）」の行に 枝肉（全体）・（下）は当たらない（（上）は等級ではなく上半身）', !typed.edaUpper && typed.edaUpperSelf, JSON.stringify(typed));
    ck('手入力「枝肉」の行には 枝肉（全体）・（下）が当たる（これまでどおり）', typed.eda, '');
    ck('「骨付き バラ」の行に骨なしのバラは当たらない／骨付バラ・ロース骨付は当たる', !typed.boneLinePlain && typed.boneLineBone, '');
    ck('普通の「バラ」の行に骨付きのバラは当たる（これまでどおり）', typed.plainLineBone, '');
    ck('「骨」の行に 骨付き○○ は当たらない（これまでは「骨」を含むので当たっていた）', !typed.hone, '');
    ck('古い書き方（上ロース→ロース・内モモ→モモ（ウチ）・ペットフード用→（あり）・ミンチ→粗挽き）は当たる', typed.old, '');
  }

  // 4. ドロップダウン
  await p.evaluate(() => loadShipping()); await p.waitForTimeout(700);
  const opts = await p.$$eval('#order-o1 select.assign-select', ss => Object.fromEntries(ss.map(s => [s.dataset.orderItemId, [...s.options].map(o => o.textContent).join('|')])));
  ck('ドロップダウン: 猪ロースの行にロースが出て、肩ロース・鹿ロースは出ない', /T902-RO/.test(opts['l-ro'] || '') && !/T903-KR/.test(opts['l-ro'] || '') && !/S901/.test(opts['l-ro'] || ''), opts['l-ro']);
  ck('ドロップダウン: 猪バラ←バラ / 猪カタ（ウデ）←カタ / 猪タン（舌）←タン（個体なしの加工パック）', /T901-BA-3/.test(opts['l-ba'] || '') && /T904-KA/.test(opts['l-kata'] || '') && /OG-261020-01/.test(opts['l-tan'] || ''), JSON.stringify(opts));
  ck('ドロップダウン: キョン（一頭分・ご希望）←キョンの枝肉', /K901/.test(opts['l-kyon'] || ''), opts['l-kyon']);

  // ドロップダウンで1行だけ割り当てる（個別に割当てられる）
  await p.evaluate(() => { const s = document.querySelector('#order-o1 select[data-order-item-id="l-kata"]'); s.value = 'v-ka'; return shipDropdownAssign(s, 'o1'); });
  await p.waitForTimeout(500);
  ck('ドロップダウンで選ぶと、その行（猪カタ（ウデ））にだけカタが割り当たる', items.some(i => i.part_name === '猪カタ（ウデ）' && i.inventory_id === 'v-ka') && items.filter(i => i.inventory_id).length === 1, JSON.stringify(items.filter(i => i.inventory_id).map(i => [i.part_name, i.inventory_id])));

  // 3. スキャン
  await p.evaluate(() => shipSelectOrder('o1')); await p.waitForTimeout(300);
  const scan = async code => {
    await p.evaluate(c => { document.getElementById('ship-scan-code').value = c; return handleShippingScan(); }, code);
    await p.waitForTimeout(500);
    return p.$eval('#ship-scan-result', el => el.innerText.replace(/\s+/g, ' '));
  };
  let msg = await scan('19000003');
  ck('スキャン: 肩ロースのパックは 猪ロースの行に入らない（部位が一致しません）', /部位が一致しません/.test(msg) && !items.some(i => i.inventory_id === 'v-kr'), msg.slice(0, 160));
  msg = await scan('19000001');
  ck('スキャン: バラのパック → 猪バラの行', /割当完了/.test(msg) && items.some(i => i.inventory_id === 'v-ba' && /^猪バラ/.test(i.part_name)), msg.slice(0, 160));
  msg = await scan('19000002');
  ck('スキャン: ロースのパック → 猪ロースの行（足りない分は残りの行になる）', /割当完了/.test(msg) && items.some(i => i.inventory_id === 'v-ro' && i.part_name === '猪ロース') && items.some(i => i.part_name === '猪ロース' && !i.inventory_id && +i.requested_kg === 0.86), msg.slice(0, 160));
  msg = await scan('19000005');
  ck('スキャン: タンのパック → 猪タン（舌）の行', /割当完了/.test(msg) && items.some(i => i.inventory_id === 'v-tan' && i.part_name === '猪タン（舌）'), msg.slice(0, 160));
  msg = await scan('19000007');
  ck('スキャン: 鹿のロースは 猪ロースの残りの行に入らない（鳥獣種が一致しません）', /鳥獣種が一致しません|部位が一致しません/.test(msg) && !items.some(i => i.inventory_id === 'v-deer'), msg.slice(0, 160));
  msg = await scan('19000006');
  ck('スキャン: キョンの枝肉 → キョン（一頭分・ご希望）の行', /割当完了/.test(msg) && items.some(i => i.inventory_id === 'v-kyon' && /^キョン/.test(i.part_name)), msg.slice(0, 160));

  // 合う在庫が無い行は「在庫なし（…）」
  await p.evaluate(() => loadShipping()); await p.waitForTimeout(700);
  const opts2 = await p.$$eval('#order-o1 select.assign-select', ss => ss.map(s => [s.dataset.part, s.options[0].textContent]));
  ck('合う在庫が無い行は「在庫なし（部位）」と書く（空のドロップダウンにしない）', opts2.length > 0 && opts2.every(([pt, t]) => /^在庫なし（/.test(t)), JSON.stringify(opts2));
  ck('pageerror なし', errs.length === 0, errs.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of out) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 300) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${out.length} passed`);
  await b.close(); srv.close();
  process.exit(pass === out.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
