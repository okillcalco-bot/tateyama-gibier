// スタッフキーで守る関数は STABLE/IMMUTABLE にしない（2026-10-10）
//
//   きっかけ: 「🍱 お弁当・イベントの感想QR」の一覧が
//     「cannot execute INSERT in a read-only transaction」で読めなかった。
//     staff_key_ok は照合のたびに記録を書き込むので、STABLE の関数から呼ぶと
//     PostgREST の読み取り専用の取引で失敗する（ブラウザのテストはRPCを差し替えるので気づけなかった）。
//
//   ここで測ること
//     migrations/*.sql をファイル名順に読み、関数ごとに最後の定義を取る。
//     staff_key_ok を呼ぶ関数の最後の定義が STABLE/IMMUTABLE なら落とす。
//     （20261010_staff_key_functions_volatile.sql の一括修正より前の定義は、修正済みとして扱う）
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '../../migrations');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
const fns = {};   // name -> {vol, calls, file}
const FIX = /provolatile\s*<>\s*'v'\s+and\s+p\.prosrc\s+ilike\s+'%staff_key_ok%'/i;
const re = /create\s+or\s+replace\s+function\s+(?:public\.)?([a-z0-9_]+)\s*\(([\s\S]*?)\$(\w*)\$([\s\S]*?)\$\3\$/gi;

for (const f of files) {
  const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
  let m;
  while ((m = re.exec(sql))) {
    const head = m[2];   // 引数〜 as の手前（returns / language / stable など）
    const vol = /\bimmutable\b/i.test(head) ? 'immutable' : /\bstable\b/i.test(head) ? 'stable' : 'volatile';
    fns[m[1].toLowerCase()] = { vol, calls: /staff_key_ok\s*\(/i.test(m[4]), file: f };
  }
  // alter function x(...) volatile
  for (const a of sql.matchAll(/alter\s+function\s+(?:public\.)?([a-z0-9_]+)\s*\([^)]*\)\s+(volatile|stable|immutable)/gi)) {
    if (fns[a[1].toLowerCase()]) fns[a[1].toLowerCase()].vol = a[2].toLowerCase();
  }
  if (FIX.test(sql)) Object.values(fns).forEach(x => { if (x.calls) x.vol = 'volatile'; });
}

const results = [];
const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
const checked = Object.entries(fns).filter(([, v]) => v.calls);
const bad = checked.filter(([, v]) => v.vol !== 'volatile').map(([k, v]) => `${k}(${v.vol}, ${v.file})`);
T(`staff_key_ok を呼ぶ関数（${checked.length}個）がすべて VOLATILE`, checked.length > 10 && bad.length === 0, bad.join(' / ') || checked.length + '個');
T('お弁当の感想QRの一覧（staff_menu_list）が VOLATILE', fns.staff_menu_list && fns.staff_menu_list.vol === 'volatile', JSON.stringify(fns.staff_menu_list));

let pass = 0;
for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
