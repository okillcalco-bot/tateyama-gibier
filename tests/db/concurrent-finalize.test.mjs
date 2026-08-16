#!/usr/bin/env node
/* 実績反映と編集の同時実行テスト（親行 FOR UPDATE による直列化）
 *
 * すべての編集/反映/取消RPCは、変更前に対象 invoice_imports 行を FOR UPDATE でロックし、
 * ロック取得後に status を判定する。これにより2セッションが同時に走っても不整合を作らない。
 * 本テストは2本のRPCを Promise.all で同時に投げ、次を確認する。
 *
 *   A. finalize と 商品変更 の同時実行
 *   B. finalize と 顧客変更 の同時実行
 *      → 編集が先なら finalize は編集後を反映。finalize が先なら編集は「編集できません」で拒否。
 *        どちらでも import は最終的に「取込済」になり、一部反映は生じない。
 *   C. finalize を2本同時
 *      → ちょうど1本だけ実績反映（already=false）、もう1本は already=true（実績は増えない）。
 *
 * 実行:  TGC_STAFF_KEY=（スタッフキー） node tests/db/concurrent-finalize.test.mjs
 *
 * 注意: 本番DBに CONCURRENCY-FINALIZE-* の取込を作り、実在顧客へ購入実績を一時的に書きます。
 * 終了時に表示される掃除SQLを Supabase SQL Editor で必ず実行してください
 * （customer_purchase_facts と invoice_imports の削除は anon からはできないため SQL Editor から）。
 */
import { createHash } from 'node:crypto';

const SB_URL = process.env.SUPABASE_URL || 'https://clpdyrehdgzgiidbfucj.supabase.co';
const SB_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNscGR5cmVoZGd6Z2lpZGJmdWNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyODEzNDksImV4cCI6MjA4ODg1NzM0OX0.cKxpyw0gyZj0Flsd8wzojiNFqyCEcrAF8tFpXXUmZck';

const staffKey = process.env.TGC_STAFF_KEY || '';
if (!staffKey) { console.error('環境変数 TGC_STAFF_KEY が必要です'); process.exit(1); }

async function rpc(fn, body) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const rand = createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 12);
const hashes = [];
const out = [];
const ck = (name, cond, detail) => out.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);

// 実在の顧客と商品を取得（テスト用の一時データは作らず、既存マスタを使う）
const custs = await rpc('admin_invoice_customer_search', { p_staff_key: staffKey, p_q: '0', p_limit: 5 });
const prods = await rpc('admin_invoice_products', { p_staff_key: staffKey });
if (!custs.length || prods.length < 2) {
  console.error('顧客または商品が取得できませんでした（顧客検索0件 / 商品2件未満）'); process.exit(1);
}
const cust = custs[0], p1 = prods[0].id, p2 = prods[1].id;

// 確認済みの取込を1件用意する（実在顧客を確定・実在商品を対応づけ）
async function setup(tag) {
  const hash = `testhash-cf-${tag}-${rand}`; hashes.push(hash);
  const r = await rpc('admin_invoice_stage_import', { p_staff_key: staffKey, p: {
    file_name: `CONCURRENCY-FINALIZE-${tag}-${rand}.xlsx`, content_hash: hash, imported_by: 'concurrent-finalize',
    documents: [{ page_from: 1, invoice_number: `CF-${tag}`, raw_customer_name: `謎の未一致店ZZZ-${rand}`,
      invoice_date: '2026-08-01', lines: [{ raw_item_name: `並列テスト品-${rand}`, weight_kg: '1', amount: '1000' }] }],
  }});
  const imp = r.import_id;
  await rpc('admin_invoice_run_matching', { p_staff_key: staffKey, p_import_id: imp });
  const d = await rpc('admin_invoice_detail', { p_staff_key: staffKey, p_import_id: imp });
  const doc = d.documents[0], line = doc.lines[0];
  await rpc('admin_invoice_set_customer', { p_staff_key: staffKey, p_document_id: doc.id, p_decision: '確定', p_customer_id: cust.id, p_by: 'concurrent-test' });
  await rpc('admin_invoice_map_product', { p_staff_key: staffKey, p_line_id: line.id, p_decision: '対応づけ', p_product_id: p1, p_by: 'concurrent-test' });
  return { imp, doc: doc.id, line: line.id };
}

// ── C: finalize 2本同時 ──
{
  const s = await setup('C');
  const rs = await Promise.allSettled([
    rpc('admin_invoice_finalize', { p_staff_key: staffKey, p_import_id: s.imp, p_by: 'A' }),
    rpc('admin_invoice_finalize', { p_staff_key: staffKey, p_import_id: s.imp, p_by: 'B' }),
  ]);
  const errs = rs.filter(r => r.status === 'rejected');
  ck('C: finalize2本ともエラーなく終了', errs.length === 0, errs.map(e => String(e.reason)).join(' / '));
  if (errs.length === 0) {
    const vals = rs.map(r => r.value);
    const reflected = vals.filter(v => v.already === false);
    const already = vals.filter(v => v.already === true);
    ck('C: 実績反映はちょうど1本（already=false が1つ）', reflected.length === 1, JSON.stringify(vals));
    ck('C: もう1本は already=true（増えない）', already.length === 1);
    ck('C: 反映した明細は1行', reflected.length === 1 && reflected[0].facts === 1);
  }
}

// ── A: finalize と 商品変更 の同時実行 ──
{
  const s = await setup('A');
  const rs = await Promise.allSettled([
    rpc('admin_invoice_finalize', { p_staff_key: staffKey, p_import_id: s.imp, p_by: 'A' }),
    rpc('admin_invoice_map_product', { p_staff_key: staffKey, p_line_id: s.line, p_decision: '対応づけ', p_product_id: p2, p_by: 'B' }),
  ]);
  const fin = rs[0], map = rs[1];
  ck('A: finalizeは成功する', fin.status === 'fulfilled', fin.status === 'rejected' ? String(fin.reason) : '');
  // 編集が先勝ちなら成功、finalizeが先勝ちなら「編集できません」で拒否。どちらも整合。
  const mapOk = map.status === 'fulfilled';
  const mapRejectedByLock = map.status === 'rejected' && /編集できません/.test(String(map.reason));
  ck('A: 商品変更は成功 or ロックで拒否（不整合な失敗ではない）', mapOk || mapRejectedByLock,
     map.status === 'rejected' ? String(map.reason).slice(0, 80) : 'fulfilled');
  const d = await rpc('admin_invoice_detail', { p_staff_key: staffKey, p_import_id: s.imp });
  ck('A: 最終状態は取込済（一部反映なし）', d.import.status === '取込済', d.import.status);
}

// ── B: finalize と 顧客変更 の同時実行 ──
{
  const s = await setup('B');
  const cust2 = custs[1] || custs[0];
  const rs = await Promise.allSettled([
    rpc('admin_invoice_finalize', { p_staff_key: staffKey, p_import_id: s.imp, p_by: 'A' }),
    rpc('admin_invoice_set_customer', { p_staff_key: staffKey, p_document_id: s.doc, p_decision: '確定', p_customer_id: cust2.id, p_by: 'B' }),
  ]);
  const fin = rs[0], setc = rs[1];
  ck('B: finalizeは成功する', fin.status === 'fulfilled', fin.status === 'rejected' ? String(fin.reason) : '');
  const setOk = setc.status === 'fulfilled';
  const setRejectedByLock = setc.status === 'rejected' && /編集できません/.test(String(setc.reason));
  ck('B: 顧客変更は成功 or ロックで拒否（不整合な失敗ではない）', setOk || setRejectedByLock,
     setc.status === 'rejected' ? String(setc.reason).slice(0, 80) : 'fulfilled');
  const d = await rpc('admin_invoice_detail', { p_staff_key: staffKey, p_import_id: s.imp });
  ck('B: 最終状態は取込済（一部反映なし）', d.import.status === '取込済', d.import.status);
}

console.log(out.join('\n'));
const hlist = hashes.map(h => `'${h}'`).join(', ');
// 直列化の意図をより明確にする検証（Supabase SQL Editor で実行）:
// 反映された実績の customer_id / product_id が、最終の invoice_documents / invoice_lines と一致すること。
// A/B は「編集が先勝ちなら反映は編集後・finalize が先勝ちなら編集は拒否」なので、下のSQLは常に一致行のみを返す。
console.log('\n== 直列化の検証（Supabase SQL Editorで実行。全行 match=true を確認） ==');
console.log(`select i.file_name, l.id as line_id,
  f.customer_id = d.customer_id as customer_match,
  f.product_id  = l.product_id  as product_match
from customer_purchase_facts f
join invoice_lines l on l.id = f.source_id
join invoice_documents d on d.id = l.document_id
join invoice_imports i on i.id = d.import_id
where f.source_kind='invoice' and i.content_hash in (${hlist}) and f.canceled_at is null;`);
console.log('\n== 掃除（検証後にSupabase SQL Editorで実行してください） ==');
console.log(`delete from customer_purchase_facts where source_kind='invoice' and source_id in (
  select l.id from invoice_lines l join invoice_documents d on d.id=l.document_id
  join invoice_imports i on i.id=d.import_id where i.content_hash in (${hlist}));`);
console.log(`delete from invoice_imports where content_hash in (${hlist});`);
process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0);
