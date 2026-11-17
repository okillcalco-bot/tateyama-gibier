// 買取金の通知書（buyback.html）: 可能な限り1枚、多数捕獲している人でも2枚に収める（2026-11-17）
//
//   きっかけ: 沖「買取料金の通知文は可能な限り1枚or多数捕獲している人でも2枚に収めるようにしたい」
//   以前は 6頭から別紙、別紙は22行ごとに1枚（79頭の人は通知書＋別紙4枚＝5枚）だった。
//   頭数で組み方を変える: 〜12頭は通知書の本文に表（1枚）／13〜30頭は別紙1段（2枚）／31〜90頭は別紙2段組み（2枚）
//
//   ここで測ること（実際にPDFにして、ページ数と文字の大きさ・余白を測る。捕獲者・個体は架空）
//     5・10・12頭 → 1枚、13・30・31・60・79・90頭 → 2枚（既定の印刷と余白「なし」の両方）
//     全ページの余白（既定 18mm 以上・なし 9mm 以上）、表の文字 9pt 前後以上、全頭ぶんの番号、合計行
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
const NS = (process.env.NS||'5,10,12,13,30,31,60,79,90').split(',').map(Number);
const INDS = [];
NS.forEach((n, k) => { for (let i = 1; i <= n; i++) INDS.push({ id:'x'+k+'_'+i, label_id:'TGC-08-T'+(k+1)+String(i).padStart(3,'0'), species: i%7===0?'キョン':(i%11===0?'シカ':'イノシシ'), capture_date:'2026-06-'+String(1 + (i % 28)).padStart(2,'0'), capture_city:'館山市', capture_area:'宮下', hunter_name: HUNTERS[k+3].name, sex: i%2?'オス':'メス', weight_total:30 + (i % 50) + 0.5, meat_rank: i%3?'並':'上', stopkill_pickup: i%4===0, intake_method: i%4===0?'引取':'持込', processing_done_at:'2026-06-30T00:00:00Z', buyback_amount:null }); });
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

  const notice = await capture(`document.getElementById('nZero').checked = true; printNotices();`);
  const n = await render('buyback-notice-pages', notice);
  for (const [key, label] of [['none', '余白「なし」'], ['css', '既定の印刷']]) {
    const pages = n[key];
    const who = []; let cur = '?'; pages.forEach(m => { const s = m.spans.find(s => /捕獲者\d\d/.test(s.text)); if (s) cur = s.text.match(/捕獲者\d\d/)[0]; who.push(cur); });
    const cnt = {}; who.forEach(w => cnt[w] = (cnt[w]||0) + 1);
    NS.forEach((num, k) => { const nm = HUNTERS[k+3].name; const want = num <= 12 ? 1 : 2; T(`${label}: ${num}頭の人は ${want}枚`, cnt[nm] === want, cnt[nm]); });
    T(`${label}: 全ページ余白 ${key === 'css' ? 18 : 9}mm 以上`, Math.min(...pages.map(m => Math.min(m.left, m.top, m.right, m.bottom))) >= (key === 'css' ? 18 : 9), pages.map(m => Math.min(m.left, m.top, m.right, m.bottom).toFixed(1)).join(','));
  }
  // 表の1行は「番号＋捕獲日」で始まる（PDFの文字の取り出しでは、同じ行のセルが空白なしでつながる）
  const nums = n.none.flatMap(m => m.spans).filter(s => /^(TGC-08-T\d+(\s?2026-|$)|T\d+\s?\d{1,2}\/\d{1,2})/.test(s.text));
  T('表の行は全頭ぶん出る（' + NS.reduce((a, b) => a + b, 0) + '行）', nums.length === NS.reduce((a, b) => a + b, 0), nums.length);
  T('表の文字は 8.9pt 以上', Math.min(...nums.map(s => s.size)) >= 8.9, Math.min(...nums.map(s => s.size)).toFixed(1));
  T('合計行は支払先ごとに1つ', n.none.flatMap(m => m.spans).filter(s => /^合計（\d+頭）$/.test(s.text)).length === NS.length, '');
  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  let pass = 0; for (const [nm, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + nm + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`); await browser.close(); process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
