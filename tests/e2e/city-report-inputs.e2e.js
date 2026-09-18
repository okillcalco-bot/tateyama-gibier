// 市役所提出（月次業務報告書）: 打合せ記録簿・収支状況をアプリのデータから Excel に転記する（2026-09-18）
//   それまで「4打ち合わせ記録簿」「6収支状況」は Excel 上で手で仕上げていた。
//   1. 入力欄: 対象月の打合せ記録と収支を読み込み、保存は city_report_inputs に month×kind で upsert
//   2. Excel: 打合せ記録簿に 回・実施日・場所・出席者・方式・協議事項（長文は行の高さを広げる）を転記
//   3. Excel: 収支状況は報告月の分が無ければ同じ年度の直近の月を使い、見出し（B1・目次）もその月にする
//   4. 打合せ記録が無い月はテンプレートのまま（壊さない）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

const ROOT = '/home/user/tateyama-gibier';
const MEETING = { month: '2026-08', kind: 'meeting', source: '農水産課 議事録メール', updated_at: '2026-09-18T00:00:00Z', data: {
  no: 5, date: '2026-08-19', time: '15:00〜16:30', place: '館山市役所　4号館2階南側会議室', method: '会議',
  client_attendees: '農水産課　土佐主事／吉原係長、中村主事', contractor_attendees: '合同会社アルコ　沖',
  items: ['①先月の状況・今後の予測', '・7月の捕獲頭数は120頭（うち南房総市60頭）となり、搬入頭数としては過去最高を記録。', '', '④その他', '・広域搬入について: 当初の予定どおり南房総市の従事者になる方法を進める（沖氏確認済）。'].concat(Array.from({ length: 30 }, (_, i) => `・協議事項の行 ${i + 1}（長文でも切れないように行の高さを広げる）`)).join('\n'),
  next: '令和8年9月16日（水）15:00〜' } };
const PL7 = { month: '2026-07', kind: 'pl', source: '千葉トラスト会計 R8.7', updated_at: '2026-09-18T00:00:00Z', data: { '売上高': 3321050, '仕入髙': 67101, '役員報酬': 90000, '給与手当': 225000, '雑給': 662115, '法定福利費': 223560, '外注費': 431913, '旅費交通費': 81874, '通信費': 39593, '交際費': 49300, '地代家賃': 35000, '保険料': 16300, '水道光熱費': 11353, '燃料費': 88393, '消耗品費': 130110, '荷造包装費': 142714, '諸会費': 36810, '管理諸費': 22000, '書籍費': 8250, '雑費': 170237 } };
const PL4 = { month: '2026-04', kind: 'pl', source: 'R8.7（4月列）', updated_at: '2026-09-18T00:00:00Z', data: { '売上高': 3669421, '仕入髙': 76451, '雑費': 124140 } };

// 無圧縮ZIP（makeZip）を読む: セントラルディレクトリからエントリ名と生データを取り出す
function unzipStored(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  const count = buf.readUInt16LE(eocd + 10); let off = buf.readUInt32LE(eocd + 16); const files = {};
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(off + 10), compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), cmtLen = buf.readUInt16LE(off + 32), lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const lnl = buf.readUInt16LE(lho + 26), lel = buf.readUInt16LE(lho + 28), start = lho + 30 + lnl + lel;
    files[name] = method === 0 ? buf.slice(start, start + compSize) : require('zlib').inflateRawSync(buf.slice(start, start + compSize));
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}
function sheetXml(files, name) {
  const wb = files['xl/workbook.xml'].toString('utf8'), rels = files['xl/_rels/workbook.xml.rels'].toString('utf8');
  const rid = (wb.match(new RegExp('<sheet[^>]*name="' + name + '"[^>]*>')) || [''])[0].match(/r:id="([^"]+)"/)[1];
  const target = rels.match(new RegExp('<Relationship[^>]*Id="' + rid + '"[^>]*>'))[0].match(/Target="([^"]+)"/)[1];
  return files['xl/' + target.replace(/^\//, '').replace(/^xl\//, '')].toString('utf8');
}
function cell(xml, ref) {
  const m = xml.match(new RegExp('<c r="' + ref + '"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)'));
  if (!m) return undefined;
  if (!m[2]) return null;
  const t = m[2].match(/<t[^>]*>([\s\S]*?)<\/t>/); if (t) return t[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const v = m[2].match(/<v>([\s\S]*?)<\/v>/); if (v) return Number(v[1]);
  return m[2].includes('<f>') ? 'F' : null;
}
function rowHt(xml, r) { const m = xml.match(new RegExp('<row r="' + r + '"[^>]*>')); const h = m && m[0].match(/ht="([^"]+)"/); return h ? Number(h[1]) : null; }

(async () => {
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    try { const b = fs.readFileSync(path.join(ROOT, p)); r.setHeader('content-type', p.endsWith('.xlsx') ? 'application/octet-stream' : 'text/html; charset=utf-8'); r.end(b); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9107);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_role_v1', 'admin'); sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {}
    window.__blobs = []; URL.createObjectURL = b => { window.__blobs.push(b); return 'blob:test'; }; URL.revokeObjectURL = () => {}; HTMLAnchorElement.prototype.click = function () {}; });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const posts = [];
  await page.route('**/rest/v1/**', r => {
    const u = decodeURIComponent(r.request().url()), m = r.request().method();
    const J = x => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (/\/attendance/.test(u)) {
      // 8月: 8/5 解体側は今泉が最後（17:10）、カット側は白石。8/6 は沖と田口だけ → 沖。8/8（土）は大橋・黒川（吉田は未打刻なので後ろ）
      return J(/2026-08-01/.test(u) ? [
        { work_date: '2026-08-05', staff_id: 's1', staff_name: '大和田薫', clock_in: '08:00', clock_out: '16:00' },
        { work_date: '2026-08-05', staff_id: 's2', staff_name: '今泉貴雄', clock_in: '08:00', clock_out: '17:10' },
        { work_date: '2026-08-05', staff_id: 's3', staff_name: '白石秀一', clock_in: '08:00', clock_out: '17:30' },
        { work_date: '2026-08-05', staff_id: 's4', staff_name: '田口和利', clock_in: '08:00', clock_out: '17:30' },
        { work_date: '2026-08-05', staff_id: 's5', staff_name: '沖浩志', clock_in: '08:00', clock_out: '18:00' },
        { work_date: '2026-08-06', staff_id: 's4', staff_name: '田口和利', clock_in: '08:00', clock_out: '17:30' },
        { work_date: '2026-08-06', staff_id: 's5', staff_name: '沖浩志', clock_in: '08:00', clock_out: '17:30' },
        { work_date: '2026-08-08', staff_id: 's6', staff_name: '大橋直人', clock_in: '08:00', clock_out: '12:40' },
        { work_date: '2026-08-08', staff_id: 's1', staff_name: '大和田薫', clock_in: '08:00', clock_out: '12:00' },
        { work_date: '2026-08-08', staff_id: 's7', staff_name: '吉田友美', clock_in: '08:00', clock_out: null },
        { work_date: '2026-08-08', staff_id: 's8', staff_name: '黒川珠絵', clock_in: '08:00', clock_out: '13:00' },
      ] : []);
    }
    if (/cleaning_logs/.test(u)) {
      // 8/7 は勤怠が無い → 清掃アプリの記録で補う
      return J(/2026-08-01/.test(u) ? [{ room: '解体室', staff_name: '相川武士', cleaned_at: '2026-08-07T08:00:00+09:00' }] : []);
    }
    if (/facility_check_logs/.test(u)) {
      // 8月: 8/5 に冷凍ストッカー1 = -19、ユニット冷蔵庫は 5℃で要改善。それ以外の日は記録なし
      return J(/2026-08-01/.test(u) ? [{ check_date: '2026-08-05', item: '冷凍ストッカー1', value: '-19', result: '可' }, { check_date: '2026-08-05', item: 'ユニット冷蔵庫', value: '5', result: '要改善' }, { check_date: '2026-08-06', item: '冷凍庫1（ホシザキ）', value: '-17', result: '可' }] : []);
    }
    if (/city_report_inputs/.test(u)) {
      if (m === 'POST') { posts.push({ url: u, prefer: r.request().headers()['prefer'], body: JSON.parse(r.request().postData() || '{}') }); return J([{}]); }
      const mm = u.match(/month=eq\.(\d{4}-\d{2})/), le = u.match(/month=lte\.(\d{4}-\d{2})/);
      if (mm) return J([MEETING, PL7, PL4].filter(x => x.month === mm[1]));
      if (le) return J([PL7, PL4].filter(x => x.month <= le[1]).sort((a, b) => b.month < a.month ? -1 : 1).slice(0, 1));
      return J([]);
    }
    return J([]);
  });
  await page.route('**/auth/**', r => r.fulfill({ contentType: 'application/json', body: '{}' }));
  await page.goto('http://localhost:9107/index.html'); await page.waitForTimeout(700);
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
  const setMonth = m => page.evaluate(m => { document.getElementById('city-report-month').value = m; }, m);
  const excel = async m => { await setMonth(m); await page.evaluate(() => cityReportExcel()); await page.waitForTimeout(300);
    const b64 = await page.evaluate(async () => { const b = window.__blobs.pop(); const ab = await new Response(b).arrayBuffer(); let s = ''; const u = new Uint8Array(ab); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); });
    return unzipStored(Buffer.from(b64, 'base64')); };

  // 1) 入力欄: 2026-08 を開くと打合せ記録が入り、収支は直近の 7月分 が入る
  await setMonth('2026-08');
  await page.evaluate(() => { const d = document.getElementById('city-inputs'); d.open = true; return cityInputsLoad(); }); await page.waitForTimeout(400);
  const ui = await page.evaluate(() => ({ no: document.getElementById('ci-m-no').value, date: document.getElementById('ci-m-date').value, items: document.getElementById('ci-m-items').value.slice(0, 20), state: document.getElementById('city-inputs-state').textContent, note: document.getElementById('ci-pl-note').textContent, sum: document.getElementById('ci-pl-sum').textContent, sales: document.querySelector('#ci-pl-grid .ci-pl[data-k="売上高"]').value }));
  T('入力欄: 打合せ記録（第5回・8/19）が読み込まれる', ui.no === '5' && ui.date === '2026-08-19' && /先月の状況/.test(ui.items), JSON.stringify(ui));
  T('入力欄: 8月の収支は無いので 7月分 を表示し、その旨を案内', /2026\/07/.test(ui.note) && ui.sales === '3321050', ui.note);
  T('入力欄: 営業損益 ¥789,427（損益計算書と一致）', /営業損益 ¥789,427/.test(ui.sum) && /販管費計 ¥2,464,522/.test(ui.sum), ui.sum);
  T('状態表示: 打合せ ✓ / 収支 直近7月分', /打合せ ✓/.test(ui.state) && /直近7月分/.test(ui.state), ui.state);

  // 2) 保存は month×kind の upsert
  await page.evaluate(() => { document.getElementById('ci-m-next').value = '令和8年9月16日（水）'; return cityInputsSave('meeting'); }); await page.waitForTimeout(300);
  T('打合せ記録の保存: on_conflict=month,kind で merge-duplicates', posts.length === 1 && /on_conflict=month,kind/.test(posts[0].url) && /merge-duplicates/.test(posts[0].prefer) && posts[0].body.month === '2026-08' && posts[0].body.kind === 'meeting' && posts[0].body.data.no === 5 && posts[0].body.data.next === '令和8年9月16日（水）', JSON.stringify(posts[0] && posts[0].body).slice(0, 200));
  await page.evaluate(() => { document.querySelector('#ci-pl-grid .ci-pl[data-k="売上高"]').value = '1000000'; return cityInputsSave('pl'); }); await page.waitForTimeout(300);
  T('収支の保存: 対象月（2026-08）の pl として保存される', posts.length === 2 && posts[1].body.month === '2026-08' && posts[1].body.kind === 'pl' && posts[1].body.data['売上高'] === 1000000 && posts[1].body.data['雑費'] === 170237, JSON.stringify(posts[1] && posts[1].body.data).slice(0, 120));

  // 3) Excel（2026-08）: 打合せ記録簿と収支状況が転記される
  const f8 = await excel('2026-08');
  const mt = sheetXml(f8, '4打ち合わせ記録簿'), pl = sheetXml(f8, '6収支状況'), idx = sheetXml(f8, '目次');
  T('打合せ記録簿: 第5回・実施日（和暦＋曜日＋時間）・場所', cell(mt, 'B4') === '第5回' && cell(mt, 'J7') === '令和8年8月19日（水） 15:00〜16:30' && cell(mt, 'J8') === '館山市役所　4号館2階南側会議室', [cell(mt, 'B4'), cell(mt, 'J7'), cell(mt, 'J8')].join(' | '));
  T('打合せ記録簿: 出席者（発注者側・受託者側）と方式', /土佐主事/.test(cell(mt, 'D7')) && cell(mt, 'D9') === '合同会社アルコ　沖' && cell(mt, 'J9') === '会議', [cell(mt, 'D7'), cell(mt, 'D9'), cell(mt, 'J9')].join(' | '));
  const items = cell(mt, 'B11');
  T('打合せ記録簿: 協議事項が本文のまま入り、末尾に次回開催', /①先月の状況/.test(items) && /広域搬入/.test(items) && /次回開催: 令和8年9月16日/.test(items), (items || '').slice(-60));
  T('打合せ記録簿: 長文なので B11:K31 の行の高さが広がる（23pt超・全行同じ）', rowHt(mt, 11) > 23 && rowHt(mt, 31) === rowHt(mt, 11) && /customHeight="1"/.test(mt.match(/<row r="20"[^>]*>/)[0]), `ht11=${rowHt(mt, 11)} ht31=${rowHt(mt, 31)}`);
  T('打合せ記録簿: 行タグに ht が二重に付かない', !/<row r="12"[^>]*\sht="[^"]*"[^>]*\sht="/.test(mt) && /<row r="12"[^>]*\sht="27"/.test(mt), (mt.match(/<row r="12"[^>]*>/) || [''])[0]);
  T('収支状況: 8月分が無いので 7月分（B1=7月）を転記、目次も「収支（令和8年7月分）」', cell(pl, 'B1') === '7月' && cell(pl, 'A1') === '令和8年度' && cell(idx, 'C15') === '収支（令和8年7月分）', [cell(pl, 'B1'), cell(idx, 'C15')].join(' | '));
  T('収支状況: 売上高 3,321,050・仕入 67,101・外注費 431,913・雑費 170,237', cell(pl, 'B2') === 3321050 && cell(pl, 'B4') === 67101 && cell(pl, 'B13') === 431913 && cell(pl, 'B34') === 170237, [cell(pl, 'B2'), cell(pl, 'B4'), cell(pl, 'B13'), cell(pl, 'B34')].join(' | '));
  T('収支状況: 無い科目（福利厚生費 B12・雑収入 B38）は空欄、式（B35・B42）は残る', cell(pl, 'B12') === null && cell(pl, 'B38') === null && cell(pl, 'B35') === 'F' && cell(pl, 'B42') === 'F', [cell(pl, 'B12'), cell(pl, 'B38'), cell(pl, 'B35')].join(' | '));

  // 3b) 点検保守: 異常なし（○）が既定。冷蔵・冷凍庫は上段○・下段に温度（記録があればその値、無ければ既定値）。苦情は「なし」
  const ck = sheetXml(f8, '2点検保守等実施記録'), cp = sheetXml(f8, '5苦情及びその対応');
  T('点検保守: 設備行は31日ぶん○（8/31 = AG列）', cell(ck, 'C3') === '○' && cell(ck, 'AG3') === '○' && cell(ck, 'AG33') === '○', [cell(ck, 'C3'), cell(ck, 'AG3'), cell(ck, 'AG33')].join(' | '));
  T('冷凍ストッカー1: 8/5 は記録の -19、他の日は既定値 -20、上段は○', cell(ck, 'G35') === -19 && cell(ck, 'C35') === -20 && cell(ck, 'AG35') === -20 && cell(ck, 'G34') === '○' && cell(ck, 'C34') === '○', [cell(ck, 'G35'), cell(ck, 'C35'), cell(ck, 'AG35'), cell(ck, 'G34')].join(' | '));
  T('ユニット冷蔵庫: 8/5 は要改善 → 上段△・下段 5、他の日は○・-1', cell(ck, 'G20') === '△' && cell(ck, 'G21') === 5 && cell(ck, 'C20') === '○' && cell(ck, 'C21') === -1, [cell(ck, 'G20'), cell(ck, 'G21'), cell(ck, 'C20'), cell(ck, 'C21')].join(' | '));
  T('冷凍庫(ホシザキ): アプリの「冷凍庫1（ホシザキ）」の記録 8/6 = -17 を拾い、他は -18', cell(ck, 'H41') === -17 && cell(ck, 'C41') === -18 && cell(ck, 'C47') === -20 && cell(ck, 'C39') === -60, [cell(ck, 'H41'), cell(ck, 'C41'), cell(ck, 'C47'), cell(ck, 'C39')].join(' | '));
  T('苦情: 「令和8年8月の苦情はありません」', cell(cp, 'B4') === '－' && cell(cp, 'E4') === '令和8年8月の苦情はありません', [cell(cp, 'B4'), cell(cp, 'E4')].join(' | '));

  // 3c) 清掃記録の担当は勤怠から（2026-09-18）: 解体側＝解体担当で最後に帰った人、カット側＝精肉担当で最後に帰った人。沖・田口だけの日は沖
  const cs = sheetXml(f8, '3清掃記録');
  T('8/5: 解体側は今泉（17:10・大和田16:00より遅い）、カット側は白石。外周も解体側の人', cell(cs, 'G4') === '今' && cell(cs, 'G10') === '白' && cell(cs, 'G3') === '今', [cell(cs, 'G4'), cell(cs, 'G10'), cell(cs, 'G3')].join(' | '));
  T('8/5: 沖・田口は最後まで居ても担当にしない', cell(cs, 'G4') !== '沖' && cell(cs, 'G10') !== '田', '');
  T('8/6: 沖と田口だけの日は両方とも 沖', cell(cs, 'H4') === '沖' && cell(cs, 'H10') === '沖', [cell(cs, 'H4'), cell(cs, 'H10')].join(' | '));
  T('8/8（土）: 解体側は大橋（12:40）→「橋」、カット側は黒川（吉田は未打刻なので後ろ）。週次の行にも入る', cell(cs, 'J4') === '橋' && cell(cs, 'J10') === '黒' && cell(cs, 'J5') === '橋' && cell(cs, 'J11') === '黒', [cell(cs, 'J4'), cell(cs, 'J10'), cell(cs, 'J5'), cell(cs, 'J11')].join(' | '));
  T('平日（8/5）は週次の行が空欄', cell(cs, 'G5') === null && cell(cs, 'G11') === null, [cell(cs, 'G5'), cell(cs, 'G11')].join(' | '));
  T('勤怠が無い日（8/7）は清掃アプリの記録で補う（相川→「相」）', cell(cs, 'I4') === '相' && cell(cs, 'I10') === null, [cell(cs, 'I4'), cell(cs, 'I10')].join(' | '));
  T('出勤の無い日（8/9）は空欄', cell(cs, 'K4') === null && cell(cs, 'K10') === null, '');

  // 4) Excel（2026-04）: その月の収支があればその月（B1=4月）。4月は30日なので31日目（AG列）は空欄
  const f4 = await excel('2026-04');
  const pl4 = sheetXml(f4, '6収支状況'), mt4 = sheetXml(f4, '4打ち合わせ記録簿'), ck4 = sheetXml(f4, '2点検保守等実施記録');
  T('4月: 31日目（AG列）は設備行も温度行も空欄、30日目（AF列）は入る', cell(ck4, 'AG3') === null && cell(ck4, 'AG34') === null && cell(ck4, 'AG35') === null && cell(ck4, 'AF3') === '○' && cell(ck4, 'AF35') === -20, [cell(ck4, 'AG3'), cell(ck4, 'AG35'), cell(ck4, 'AF3'), cell(ck4, 'AF35')].join(' | '));
  T('4月: 4月分の収支（売上 3,669,421）・B1=4月', cell(pl4, 'B1') === '4月' && cell(pl4, 'B2') === 3669421 && cell(pl4, 'B34') === 124140, [cell(pl4, 'B1'), cell(pl4, 'B2')].join(' | '));
  T('4月: 打合せ記録が無い月はテンプレートのまま（案内文が残る）', /議事録メールを基に記入/.test(cell(mt4, 'B11')) && cell(mt4, 'B4') === '第　回' && rowHt(mt4, 11) === 23, [cell(mt4, 'B4'), rowHt(mt4, 11)].join(' | '));
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close(); srv.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
