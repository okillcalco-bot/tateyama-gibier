// 買取金額通知（buyback.html）の印刷: 通知書・告知文に余白があり文字が大きい／宛名ラベルが KML-506 の枠に収まる
//
//   きっかけ（2026-09-17）
//     通知書と告知文を印刷したら余白が全く無かった。原因は納品書（#309）と同じで、印刷ダイアログの余白が
//     「なし」だと @page の余白が消える。余白を用紙側(@page 10mm)と紙面側(.pg padding 12/10mm)の両方で取り、
//     文字も本文13pt・表10.5pt に大きくした（表は9列を1行に収めるため折り返し禁止）。別紙は22行ごとに手で改ページ（ページ途中で表が割れない）。
//     あわせて、捕獲者台帳の住所から宛名ラベル（コメリ KML-506：A4 24面 70×33.9mm・上下余白12.9mm）を刷る。
//
//   ここで測ること（実際にPDFにして文字の位置をmmで測る）
//     1. 通知書: 既定（@page）で印刷 → 全ページで余白 18mm 以上。余白「なし」でも 9mm 以上。
//     2. 通知書: 5頭の人は1枚、50頭の人は 通知1枚＋別紙3枚（22行×2＋6行）。表の文字が 10.5pt 以上、本文 13pt 以上。
//     3. 告知文: どちらの印刷でも余白 10mm 以上、右端がはみ出さない。
//     4. 宛名ラベル: 余白「なし」で印刷したとき、各ラベルの文字がそのラベルの枠（70×33.9mm、上余白12.9mm）に収まる。
//        開始位置3枚目なら 1・2枚目は空。25人なら2枚。
const pw = (() => { try { return require('/opt/node22/lib/node_modules/playwright'); } catch (e) { return require('playwright'); } })();
const { chromium } = pw;
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const RULES = { boar:{ female_rank_unit:{'並':100,'上':200,'極上':300}, male_unit:100, yield_ranks:[{rank:'A',min_pct:30,ratio:1,label:'3割以上'},{rank:'B',min_pct:20,ratio:0.5,label:'2〜3割'},{rank:'C',min_pct:10,ratio:0.3,label:'1〜2割'},{rank:'D',min_pct:0,ratio:0,label:'1割未満'}], weight_floor:true, min_weight_kg:20 }, deer:{unit:100,use_yield:true}, small:{price:1000,species:['キョン','アライグマ','ハクビシン','タヌキ','ノウサギ']}, pickup_fee:3000, source:'テスト' };
const HUNTERS = [
  { id:'h1', name:'井上　定男', furigana:'いのうえさだお', bank_name:'ＪＡ安房', bank_branch:'館野支店', account_type:'普通', account_number:'4111589', account_furigana:'ｲﾉｳｴ ｻﾀﾞｵ', payee_no:4, city:'館山市', address:'館山市神余454', postal_code:'2940223' },
  { id:'h2', name:'山田千代子', furigana:'やまだちよこ', payee_no:11, city:'館山市', address:'千葉県船橋市滝台2-13-13 603', postal_code:null },
  { id:'h3', name:'鈴木　太郎', furigana:'すずきたろう', payee_no:12, city:'南房総市', address:null, postal_code:null },
];
for (let i = 4; i <= 25; i++) HUNTERS.push({ id:'h'+i, name:`捕獲者${String(i).padStart(2,'0')}`, furigana:'ほかくしゃ'+i, city:'館山市', address:`館山市大字テスト${i}-${i}`, postal_code:'294-00'+String(i).padStart(2,'0') });
const INDS = [];
for (let i = 1; i <= 5; i++) INDS.push({ id:'a'+i, label_id:'TGC-08-T0'+String(i).padStart(2,'0'), species:'イノシシ', capture_date:'2026-05-'+String(i).padStart(2,'0'), capture_city:'館山市', capture_area:'神余', hunter_name:'井上定男', sex:'メス', weight_total:40, meat_rank:'並', stopkill_pickup:false, intake_method:'搬入', processing_done_at:'2026-05-20T02:00:00Z' });
for (let i = 1; i <= 50; i++) INDS.push({ id:'b'+i, label_id:'TGC-08-T1'+String(i).padStart(2,'0'), species:'イノシシ', capture_date:'2026-06-'+String(1 + (i % 28)).padStart(2,'0'), capture_city:'南房総市', capture_area:'宮下', hunter_name:'山田千代子', sex:'オス', weight_total:30 + (i % 20), meat_rank:'並', stopkill_pickup:false, intake_method:'搬入', processing_done_at:'2026-07-01T02:00:00Z' });
const INV = INDS.map(i => ({ individual_id: i.label_id, weight: 12, weight_kg: 12 }));

const MEASURE = `
import pymupdf, json, sys
d = pymupdf.open(sys.argv[1]); mm = 25.4/72; out = []
for p in d:
    W, H = p.rect.width, p.rect.height
    blocks = [b for b in p.get_text('blocks') if b[4].strip()]
    spans = []
    for b in p.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            ss = [x for x in l['spans'] if x['text'].strip()]
            if not ss: continue
            spans.append({'x0': min(x['bbox'][0] for x in ss)*mm, 'y0': min(x['bbox'][1] for x in ss)*mm, 'x1': max(x['bbox'][2] for x in ss)*mm, 'y1': max(x['bbox'][3] for x in ss)*mm, 'size': max(x['size'] for x in ss), 'text': ''.join(x['text'] for x in ss)})
    if blocks:
        out.append({'left': min(b[0] for b in blocks)*mm, 'top': min(b[1] for b in blocks)*mm, 'right': (W-max(b[2] for b in blocks))*mm, 'bottom': (H-max(b[3] for b in blocks))*mm, 'maxx': max(b[2] for b in blocks)*mm, 'w': W*mm, 'h': H*mm, 'spans': spans})
    else:
        out.append({'left': 999, 'top': 999, 'right': 999, 'bottom': 999, 'maxx': 0, 'w': W*mm, 'h': H*mm, 'spans': []})
print(json.dumps(out))
`;

(async () => {
  const outDir = process.env.DOC_TEST_OUT || require('os').tmpdir();
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext(); await ctx.addInitScript(() => sessionStorage.setItem('tg_role_v1', 'admin'));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url()), m = r.request().method();
    if (u.startsWith('file:')) return r.continue();
    if (/fonts\./.test(u)) return r.fulfill({ status: 200, body: '' });
    const J = x => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') return J([]);
    if (/app_settings/.test(u)) return J([{ key: 'buyback_rules', value: RULES }]);
    if (/\/hunters/.test(u)) return J(HUNTERS);
    if (/\/individuals/.test(u)) return J(INDS);
    if (/\/inventory/.test(u)) return J(INV);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../buyback.html'));
  await page.waitForTimeout(700);
  await page.selectOption('#fYear', '8'); await page.selectOption('#fHalf', 'H1');
  await page.evaluate(() => { fillPeriod(); return runCalc(); });
  await page.waitForTimeout(800);

  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
  const capture = fn => page.evaluate(fn => { let out = ''; const orig = window.open; window.open = () => ({ document: { write: h => { out += h; }, close(){} } }); try { eval(fn); } finally { window.open = orig; } return out; }, fn);
  const measure = f => JSON.parse(execFileSync('python3', ['-c', MEASURE, f], { encoding: 'utf8' }));
  const render = async (name, html) => {
    const hp = path.join(outDir, name + '.html'); fs.writeFileSync(hp, html);
    const p2 = await ctx.newPage(); await p2.route('**/fonts.*', r => r.fulfill({ status: 200, body: '' }));
    await p2.goto('file://' + hp); await p2.waitForTimeout(300);
    const a = path.join(outDir, name + '-css.pdf'), b = path.join(outDir, name + '-none.pdf');
    await p2.pdf({ path: a, format: 'A4', preferCSSPageSize: true, printBackground: true });
    await p2.pdf({ path: b, format: 'A4', margin: { top: '0', right: '0', bottom: '0', left: '0' }, printBackground: true });
    await p2.close();
    return { css: measure(a), none: measure(b) };
  };
  const fmtAll = pages => pages.map((m, i) => `p${i+1}: 左${m.left.toFixed(1)} 上${m.top.toFixed(1)} 右${m.right.toFixed(1)} 下${m.bottom.toFixed(1)}`).join(' / ');
  const minMargin = pages => Math.min(...pages.map(m => Math.min(m.left, m.top, m.right, m.bottom)));

  // ── 通知書 ──
  const notice = await capture(`document.getElementById('nZero').checked = true; printNotices();`);
  T('通知書HTML: 井上（5頭・本文に表）と山田（50頭・別紙）', /井上定男　様/.test(notice) && /山田千代子　様/.test(notice) && /別紙のとおり/.test(notice) && (notice.match(/別紙　山田千代子　様/g)||[]).length === 3, (notice.match(/別紙　/g)||[]).length);
  const n = await render('buyback-notice', notice);
  T('通知書: 既定の印刷で 1＋(1＋3)＝5ページ', n.css.length === 5, n.css.length);
  T('通知書: 余白「なし」でも 5ページ（別紙が途中で割れない）', n.none.length === 5, n.none.length);
  T('通知書: 既定の印刷は全ページ余白 18mm 以上', minMargin(n.css) >= 18, fmtAll(n.css));
  T('通知書: 余白「なし」でも全ページ余白 9mm 以上', minMargin(n.none) >= 9, fmtAll(n.none));
  T('通知書: 右端がはみ出さない（≤ 200mm）', n.none.every(m => m.maxx <= 200), n.none.map(m => m.maxx.toFixed(1)).join(','));
  const allSpans = n.none.flatMap(m => m.spans); const body = allSpans.find(s => /拝啓/.test(s.text)); const tbl = allSpans.find(s => /TGC-08-T001/.test(s.text)); const h1 = allSpans.find(s => /買取金のご通知/.test(s.text));
  T('通知書: 本文 13pt 以上・表 10.5pt 以上・題 17pt 以上', body && body.size >= 12.9 && tbl && tbl.size >= 10.4 && h1 && h1.size >= 16.9, JSON.stringify({ body: body && body.size, tbl: tbl && tbl.size, h1: h1 && h1.size }));
  const rowsPer = n.none.map(m => m.spans.filter(s => /TGC-08-T1\d\d/.test(s.text)).length);
  T('別紙は 22・22・6 行、最後の別紙に合計行', rowsPer.filter(x => x > 0).join(',') === '22,22,6' && n.none.some(m => m.spans.some(s => /合計（50頭）/.test(s.text))), rowsPer.join(','));

  // ── 告知文 ──
  const ann = await capture(`printAnnouncement();`);
  const a = await render('buyback-announce', ann);
  T('告知文: 既定の印刷で余白 18mm 以上', minMargin(a.css) >= 18, fmtAll(a.css));
  T('告知文: 余白「なし」でも 9mm 以上・右端 ≤ 200mm', minMargin(a.none) >= 9 && a.none.every(m => m.maxx <= 200), fmtAll(a.none));
  const at = a.none[0].spans.find(s => /買取価格は、獣種/.test(s.text));
  T('告知文: 本文 12.5pt 以上・1ページに収まる', at && at.size >= 12.4 && a.none.length === 1 && a.css.length === 1, JSON.stringify({ size: at && at.size, pages: a.none.length }));

  // ── 宛名ラベル（KML-506） ──
  await page.evaluate(() => { showTab('notice'); document.getElementById('lblTarget').value = 'all'; document.getElementById('lblStart').value = '3'; });
  const lbl = await capture(`printAddressLabels();`);
  T('ラベルHTML: 24面×2枚（25人＋空2）、住所無しは「住所未登録」、千葉県が付く、〒はハイフン付き', (lbl.match(/class="sheet"/g)||[]).length === 2 && /住所未登録/.test(lbl) && /千葉県館山市神余454/.test(lbl) && /〒294-0223/.test(lbl) && /千葉県千葉県/.test(lbl) === false && /千葉県船橋市滝台/.test(lbl), (lbl.match(/class="sheet"/g)||[]).length);
  const status = await page.evaluate(() => document.getElementById('statusBar').textContent);
  T('住所が無い人は画面で警告（鈴木）', /住所が台帳に無い人 1人/.test(status) && /鈴木/.test(status), status.slice(0, 80));
  const L = await render('buyback-labels', lbl);
  const S = { cols:3, rows:8, w:70, h:33.9, top:12.9 };
  const pad = { l: 5.5, r: 5.5, t: 3.0, b: 1.5 };  // .lbl の padding（3.5mm/6mm/2mm）より少し緩い判定
  let bad = [], perCell = {};
  L.none.forEach((pg, pi) => pg.spans.forEach(s => {
    const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2;
    const col = Math.floor(cx / S.w), row = Math.floor((cy - S.top) / S.h);
    const idx = pi * 24 + row * S.cols + col; perCell[idx] = (perCell[idx] || 0) + 1;
    const x0 = col * S.w + pad.l, x1 = (col + 1) * S.w - pad.r, y0 = S.top + row * S.h + pad.t, y1 = S.top + (row + 1) * S.h - pad.b;
    if (s.x0 < x0 - 0.3 || s.x1 > x1 + 0.3 || s.y0 < y0 - 0.3 || s.y1 > y1 + 0.3) bad.push(`p${pi+1} r${row} c${col} "${s.text.slice(0,12)}" ${s.x0.toFixed(1)},${s.y0.toFixed(1)}-${s.x1.toFixed(1)},${s.y1.toFixed(1)}`);
  }));
  T('ラベル: 余白「なし」で2ページ', L.none.length === 2, L.none.length);
  T('ラベル: 全ての文字が自分のラベルの枠内（70×33.9mm・上余白12.9mm）に収まる', bad.length === 0, bad.slice(0, 4).join(' | '));
  T('ラベル: 開始位置3 → 1・2枚目は空、3枚目から', !perCell[0] && !perCell[1] && perCell[2] > 0, JSON.stringify([perCell[0], perCell[1], perCell[2]]));
  T('ラベル: 25人が 3〜27枚目（2枚目のシートの3枚目まで）', perCell[26] > 0 && !perCell[27], JSON.stringify([perCell[26], perCell[27]]));
  const first = L.none[0].spans.filter(s => Math.floor(((s.y0 + s.y1) / 2 - S.top) / S.h) === 0 && Math.floor((s.x0 + s.x1) / 2 / S.w) === 2);
  T('ラベル: 3枚目（1段目右）の文字が 〒→住所→名前 の順で上から並ぶ', first.length >= 3 && first[0].y0 >= S.top + 3 && first[0].y0 < S.top + 8, first.map(s => s.text.slice(0, 8) + '@' + s.y0.toFixed(1)).join(' '));
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [nm, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + nm + (got ? '  [' + String(got).slice(0, 260) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
