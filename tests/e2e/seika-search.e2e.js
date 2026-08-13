const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type','text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch(e){ r.statusCode=404; r.end('nf'); }
  }).listen(9070);
  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(()=>chromium.launch());
  const out=[]; const ck=(n,c,e)=>out.push((c?'PASS ':'FAIL ')+n+(e?' — '+e:''));
  const SI012 = { label_id:'TGC-08-シ012', species:'シカ', weight_total:null, capture_date:null, hunter_name:null, quality:null, serial_number:12, processing_done_at:null, intake_status:null };
  let lastSearchUrl='';
  const ctx = await b.newContext({ viewport:{width:1200,height:800} });
  const p = await ctx.newPage();
  await p.route('**/rest/v1/**', async route => {
    const url = decodeURIComponent(route.request().url());
    const j = x => route.fulfill({ contentType:'application/json', body: JSON.stringify(x) });
    if (url.includes('/individuals?or=(')) {
      lastSearchUrl = url;
      // 「シカ」種類一致・「シ012」ラベル一致・serial 12 一致のいずれかで シ012 を返す
      const hit = /species\.ilike\.\*シカ/.test(url) || /label_id\.ilike\.\*[^,]*シ012/.test(url) || /serial_number\.eq\.12(\b|&|\))/.test(url);
      return j(hit ? [SI012] : []);
    }
    return j([]);
  });
  await p.goto('http://localhost:9070/index.html'); await p.waitForTimeout(800);
  // 精肉モードのオーバーレイを表示状態に（検索対象のDOMを可視化）
  await p.evaluate(()=>document.getElementById('pmOverlay').classList.add('active'));

  async function search(term){
    await p.evaluate(t=>{ document.getElementById('pmIndSearch').value=t; }, term);
    await p.evaluate(()=>pmSearchIndividuals());
    await p.waitForTimeout(300);
    return p.evaluate(()=>document.getElementById('pmIndList').textContent);
  }

  let t = await search('シカ12');
  ck('「シカ12」でシ012が出る', t.includes('TGC-08-シ012'), t.replace(/\s+/g,' ').slice(0,80));
  ck('「シカ12」で serial_number.eq.12 を送る', /serial_number\.eq\.12/.test(lastSearchUrl));
  ck('「シカ12」で空枠バッジが出る', t.includes('空枠'));

  t = await search('012');
  ck('「012」でシ012が出る(serial一致)', t.includes('TGC-08-シ012') && /serial_number\.eq\.12/.test(lastSearchUrl));

  t = await search('シカ');
  ck('「シカ」で種類一致してシ012が出る', t.includes('TGC-08-シ012') && /species\.ilike/.test(lastSearchUrl));

  t = await search('シ012');
  ck('「シ012」でラベル一致してシ012が出る', t.includes('TGC-08-シ012'));

  // 構造文字の除去（注入されない）
  await p.evaluate(()=>{ document.getElementById('pmIndSearch').value=')(,%*'; });
  await p.evaluate(()=>pmSearchIndividuals());
  await p.waitForTimeout(300);
  ck('構造文字は除去して送る', !/[()%*]/.test((lastSearchUrl.split('or=(')[1]||'').split('&')[0].replace(/\.ilike\.\*|\*,|\*\)/g,'')), lastSearchUrl.slice(0,120));

  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x=>x.startsWith('FAIL'))?1:0);
})();
