#!/usr/bin/env node
/* 請求書のローカル取込（経路B）
 *
 *   node scripts/import-invoices.mjs --dir import/invoices --dry-run      # 抽出だけ（DBに触れない）
 *   node scripts/import-invoices.mjs --dir import/invoices --push        # 投入＋今回投入分だけ名寄せ
 *   node scripts/import-invoices.mjs --dir import/invoices --push --rematch-all
 *                                             # 明示指定時のみ、過去の未照合・候補あり全件を再照合
 *
 * --push には環境変数 TGC_STAFF_KEY（スタッフキー）が必要。キーは引数に書かない・ログに出さない。
 * 冪等: 同じ内容のファイル（SHA-256一致）はDB側でskipされるので、何度実行しても二重取込にならない。
 * 名寄せは「今回新規投入した import_id」だけを対象に実行する。skipされた既存ファイルや
 * 過去のステージングデータは、--rematch-all を明示しない限り触らない。
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
const rematchAll = opt('--rematch-all');

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
const newImportIds = [];   // 今回新規投入した import_id（名寄せはこの分だけ）
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
      // 個人情報をログへ残さない: 電話は下2桁以外を伏せる（照合はDB側で行う）
      const tel = d.raw_phone ? String(d.raw_phone).replace(/\d(?=[\d-]*\d\d)/g, '*') : '-';
      console.log(`   宛名:${d.raw_customer_name ?? '?'} 電話:${tel} 日付:${d.invoice_date ?? '-'} 番号:${d.invoice_number ?? '-'}`);
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
  if (!r.skipped && r.import_id) newImportIds.push(r.import_id);
}

if (push) {
  if (rematchAll) {
    // 明示指定時だけ全件（過去の未照合・候補あり含む）を再照合
    const m = await rpc('admin_invoice_run_matching', { p_staff_key: staffKey, p_import_id: null });
    console.log(`名寄せ(全件再照合): 自動確定 ${m.auto} / 候補あり ${m.candidates} / 未照合 ${m.unmatched}`);
  } else if (newImportIds.length) {
    // 既定: 今回新規投入した import_id だけを名寄せ（skipped済み・過去分は触らない）
    let auto = 0, cand = 0, none = 0;
    for (const id of newImportIds) {
      const m = await rpc('admin_invoice_run_matching', { p_staff_key: staffKey, p_import_id: id });
      auto += m.auto; cand += m.candidates; none += m.unmatched;
    }
    console.log(`名寄せ(今回投入 ${newImportIds.length}件): 自動確定 ${auto} / 候補あり ${cand} / 未照合 ${none}`);
  } else {
    console.log('名寄せ: 今回の新規投入は0件のためスキップ（全件再照合は --rematch-all）');
  }
}

console.log('\n== 結果 ==');
for (const s of summary) console.log(`${s.status.padEnd(10)} ${s.name}  ${s.detail}`);
console.log(dryRun ? '\n（dry-run: DBには何も書いていません。投入は --push）' : '\n投入完了。確認は受発注管理の請求書取込画面で。');
