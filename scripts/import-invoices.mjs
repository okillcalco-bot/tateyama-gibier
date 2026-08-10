#!/usr/bin/env node
/* 請求書のローカル取込（経路B）
 *
 *   node scripts/import-invoices.mjs --dir import/invoices --dry-run   # 抽出だけ（DBに触れない）
 *   node scripts/import-invoices.mjs --dir import/invoices --push     # ステージングへ投入＋名寄せ実行
 *
 * --push には環境変数 TGC_STAFF_KEY（スタッフキー）が必要。キーは引数に書かない・ログに出さない。
 * 冪等: 同じ内容のファイル（SHA-256一致）はDB側でskipされるので、何度実行しても二重取込にならない。
 * 画像・画像PDFはここでは読まず一覧に「画像認識へ」と表示するだけ（1枚ずつ人が確認できる経路で別途投入）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { execFileSync } from 'node:child_process';

const SB_URL = process.env.SUPABASE_URL || 'https://clpdyrehdgzgiidbfucj.supabase.co';
const SB_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNscGR5cmVoZGd6Z2lpZGJmdWNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyODEzNDksImV4cCI6MjA4ODg1NzM0OX0.cKxpyw0gyZj0Flsd8wzojiNFqyCEcrAF8tFpXXUmZck';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0; };
const optVal = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const dir = optVal('--dir', 'import/invoices');
const push = opt('--push');
const dryRun = opt('--dry-run') || !push;

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

function listFiles(d) {
  const out = [];
  for (const name of readdirSync(d)) {
    if (name.startsWith('.') || name === '_samples') continue;
    const p = join(d, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out.sort();
}

const files = listFiles(dir);
if (!files.length) {
  console.log(`対象ファイルがありません: ${dir}/ に請求書（.xlsx / .pdf）を置いてください`);
  process.exit(0);
}

let staffKey = '';
if (push) {
  staffKey = process.env.TGC_STAFF_KEY || '';
  if (!staffKey) { console.error('--push には環境変数 TGC_STAFF_KEY が必要です'); process.exit(1); }
}

const summary = [];
for (const path of files) {
  const name = basename(path);
  const buf = readFileSync(path);
  const hash = createHash('sha256').update(buf).digest('hex');
  let extracted = null, skipReason = '';
  try {
    const out = execFileSync('python3', [join('scripts', 'extract-invoice.py'), path], { encoding: 'utf8' });
    extracted = JSON.parse(out);
  } catch (e) {
    if (e.status === 3) skipReason = '画像のため対象外（画像認識の経路で1枚ずつ投入する）';
    else if (e.status === 2) skipReason = `未対応の形式（${extname(path)}）`;
    else skipReason = `抽出エラー: ${String(e.message).slice(0, 120)}`;
  }
  if (!extracted) {
    summary.push({ name, status: 'skip', detail: skipReason });
    continue;
  }
  const docs = extracted.documents || [];
  const lines = docs.reduce((a, d) => a + (d.lines || []).length, 0);
  if (dryRun) {
    summary.push({ name, status: 'dry-run', detail: `${docs.length}枚 ${lines}行` });
    console.log(`── ${name}（${docs.length}枚・${lines}行）`);
    for (const d of docs) {
      console.log(`   宛名:${d.raw_customer_name ?? '?'} 電話:${d.raw_phone ?? '-'} 日付:${d.invoice_date ?? '-'} 番号:${d.invoice_number ?? '-'}`);
      for (const l of d.lines) {
        console.log(`     ${l.raw_item_name}  ${l.weight_kg ?? '?'}kg × ¥${l.unit_price ?? '?'} = ¥${l.amount ?? '?'}  [${l.source_ref}]`);
      }
    }
    continue;
  }
  const r = await rpc('admin_invoice_stage_import', {
    p_staff_key: staffKey,
    p: {
      source: 'local', file_name: name, content_hash: hash,
      mime_type: extname(path).slice(1), page_count: extracted.page_count,
      imported_by: 'import-invoices.mjs', documents: docs,
    },
  });
  summary.push({ name, status: r.skipped ? 'skip(取込済)' : '投入', detail: r.skipped ? r.reason : `${r.documents}枚 ${r.lines}行` });
}

if (push) {
  const m = await rpc('admin_invoice_run_matching', { p_staff_key: staffKey, p_import_id: null });
  console.log(`名寄せ: 自動確定 ${m.auto} / 候補あり ${m.candidates} / 未照合 ${m.unmatched}`);
}

console.log('\n== 結果 ==');
for (const s of summary) console.log(`${s.status.padEnd(10)} ${s.name}  ${s.detail}`);
console.log(dryRun ? '\n（dry-run: DBには何も書いていません。投入は --push）' : '\n投入完了。確認は受発注管理の請求書取込画面で。');
