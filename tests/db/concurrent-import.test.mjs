#!/usr/bin/env node
/* 同時投入の競合テスト（admin_invoice_stage_import の原子性）
 *
 * 同じ content_hash の取込リクエストを Promise.all で同時に2本投げ、
 *   1. 両方ともエラーなく終了する
 *   2. 片方だけ skipped=false（新規作成）、もう片方は skipped=true
 *   3. 両方が同じ import_id を返す
 * ことを確認する。
 *
 * 実行:  TGC_STAFF_KEY=（スタッフキー） node tests/db/concurrent-import.test.mjs
 *
 * 注意: このテストは本番DBに CONCURRENCY-TEST という名前の取込を1件作ります。
 * 終了時に表示される掃除SQLを Supabase SQL Editor で実行して消してください
 * （invoice_imports の削除は anon からはできないため、SQL Editorから行う）。
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

const hash = 'testhash-concurrent-' + createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 24);
const payload = (n) => ({
  p_staff_key: staffKey,
  p: {
    source: 'local',
    file_name: `CONCURRENCY-TEST-${n}.xlsx`,
    content_hash: hash,
    imported_by: 'concurrent-import.test.mjs',
    documents: [{ page_from: 1, invoice_number: `RACE-${n}`,
      lines: [{ raw_item_name: '競合テスト品' }] }],
  },
});

const results = await Promise.allSettled([
  rpc('admin_invoice_stage_import', payload(1)),
  rpc('admin_invoice_stage_import', payload(2)),
]);

const out = [];
const ck = (name, cond, detail) => out.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);

const errors = results.filter(r => r.status === 'rejected');
ck('両リクエストがエラーなく終了する', errors.length === 0,
   errors.map(e => String(e.reason)).join(' / '));

if (errors.length === 0) {
  const [a, b] = results.map(r => r.value);
  const created = [a, b].filter(r => r.skipped === false);
  const skipped = [a, b].filter(r => r.skipped === true);
  ck('作成は1件だけ（skipped=false が1つ）', created.length === 1, JSON.stringify([a, b]));
  ck('もう片方は skipped=true', skipped.length === 1);
  ck('両方が同じ import_id を返す', a.import_id && a.import_id === b.import_id,
     `${a.import_id} / ${b.import_id}`);
}

console.log(out.join('\n'));
console.log('\n== 掃除（Supabase SQL Editorで実行してください） ==');
console.log(`delete from invoice_imports where content_hash = '${hash}';`);
process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0);
