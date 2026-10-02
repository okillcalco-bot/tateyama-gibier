// 架空の注文書PDFを作る（テスト用）。実在の店舗・個人の情報は使わない。
// 実行: NODE_PATH=/opt/node22/lib/node_modules node make-pdfs.cjs
const { chromium } = require('playwright');
const path = require('path');
const DOCS = {
  'O-DEMO-001.pdf': { no: 'O-DEMO-001', to: '館山ジビエセンター 御中', from: 'レストランA（架空）', date: '2026-10-01',
    rows: [['猪ロース', '2本', 'フレッシュ希望']], due: '（空欄）', note: '用意でき次第お送りください' },
  'O-DEMO-002.pdf': { no: 'O-DEMO-002', to: '館山ジビエセンター 御中', from: 'ビストロB（架空）', date: '2026-10-01',
    rows: [['猪 肩', '600g', '冷凍'], ['猪 スネ', '600g', '冷凍']], due: '2026-10-09', note: '' },
  'O-DEMO-003.pdf': { no: 'O-DEMO-003', to: '館山ジビエセンター 御中', from: 'ジビエ食堂C（架空）', date: '2026-10-02',
    rows: [['アライグマ 枝肉', '1頭', '']], due: '', note: '' },
};
const MULTI = 'O-DEMO-004_005.pdf';
const page = d => `<section style="page-break-after:always;font-family:sans-serif;padding:24px">
  <h1 style="font-size:20px">注文書　No. ${d.no}</h1><p>${d.to}</p><p>発注元: ${d.from}　注文日: ${d.date}</p>
  <table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>品名</th><th>数量</th><th>温度帯</th></tr>
  ${d.rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</table>
  <p>納品希望日: ${d.due || '（空欄）'}</p><p>備考: ${d.note}</p><p style="color:#888">※テスト用の架空データ</p></section>`;
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage();
  for (const [f, d] of Object.entries(DOCS)) { await p.setContent(`<meta charset="utf-8">${page(d)}`); await p.pdf({ path: path.join(__dirname, f), format: 'A4' }); }
  await p.setContent('<meta charset="utf-8">' + page({ no: 'O-DEMO-004', to: '館山ジビエセンター 御中', from: 'レストランA（架空）', date: '2026-10-02', rows: [['猪バラ', '1kg', '冷凍']], due: '2026-10-10', note: '' })
    + page({ no: 'O-DEMO-005', to: '館山ジビエセンター 御中', from: 'レストランA（架空）', date: '2026-10-02', rows: [['猪モモ', '2kg', '冷凍']], due: '2026-10-10', note: '' }));
  await p.pdf({ path: path.join(__dirname, MULTI), format: 'A4' });
  await b.close();
})();
