const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type','text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch(e){ r.statusCode=404; r.end('nf'); }
  }).listen(9073);
  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(()=>chromium.launch());
  const out=[]; const ck=(n,c,e)=>out.push((c?'PASS ':'FAIL ')+n+(e?' — '+e:''));
  const mk = (lbl,serial) => ({ id:'x', label_id:lbl, species:'シカ', serial_number:serial, processing_done_at:null, deleted_at:null });
  const S11 = mk('TGC-08-シ011',11), S12 = mk('TGC-08-シ012',12);
  const ctx = await b.newContext({ viewport:{width:1000,height:700} });
  const p = await ctx.newPage();
  await p.route('**/rest/v1/**', async route => {
    const url = decodeURIComponent(route.request().url());
    const j = x => route.fulfill({ contentType:'application/json', body: JSON.stringify(x) });
    if (url.includes('/individuals')) {
      // exact label
      if (url.includes('label_id=eq.TGC-08-シ011')) return j([S11]);
      if (url.includes('label_id=eq.TGC-08-シ012')) return j([S12]);
      // serial
      if (url.includes('serial_number=eq.11')) return j([S11]);
      if (url.includes('serial_number=eq.12')) return j([S12]);
      // ilike fallback (救済)
      if (url.includes('label_id=ilike.*-シ011')) return j([S11]);
      if (url.includes('label_id=ilike.*-シ012')) return j([S12]);
      return j([]);
    }
    return j([]);
  });
  await p.goto('http://localhost:9073/index.html'); await p.waitForTimeout(600);
  const resolve = (c) => p.evaluate(async x => { const r = await resolveIndividualByCode(x); return r ? r.label_id : null; }, c);
  for (const [code, want] of [
    ['シ011','TGC-08-シ011'], ['シ012','TGC-08-シ012'],
    ['シカ011','TGC-08-シ011'], ['シカ11','TGC-08-シ011'],
    ['SK011','TGC-08-シ011'], ['SK11','TGC-08-シ011'],
    ['TGC-08-SK011','TGC-08-シ011'], ['TGC-08-シ012','TGC-08-シ012'],
    ['011','TGC-08-シ011'], ['12','TGC-08-シ012'],
  ]) {
    const r = await resolve(code);
    ck(`「${code}」→ ${r||'×'}`, r === want, r||'null');
  }
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x=>x.startsWith('FAIL'))?1:0);
})();
