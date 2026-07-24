import type { DbPort } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";
import { DOC_TYPES, type DocType } from "./billing-service";

/**
 * Misoca CSVインポート。
 * Misocaの「書類一覧のCSVダウンロード」を取り込み、billing_documents に
 * 過去帳票として保存する（source='misoca'）。
 * - 列名の揺れに強いヘッダーマッピング（請求書/見積書/納品書CSVで列名が異なる）
 * - 番号・金額（小計/消費税/合計）は Misoca の値をそのまま保持する
 *   （再計算しない。過去の発行済み書類は事実として保存する = データは資産）
 * - 一覧CSVに明細行は含まれないため、items は件名1行のスナップショットになる
 */

export interface MisocaDocRow {
  docNumber: string;
  issueDate: string; // ISO
  customerName: string;
  subject: string;
  subtotal: number | null;
  tax: number | null;
  total: number;
  dueDate: string | null;
}

/** RFC4180風の最小CSVパーサ（引用符・改行・カンマ対応） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const COLUMN_CANDIDATES: Record<keyof MisocaDocRow, string[]> = {
  docNumber: ["請求書番号", "見積書番号", "納品書番号", "領収書番号", "書類番号", "伝票番号", "番号", "No", "No."],
  issueDate: ["発行日", "請求日", "見積日", "納品日", "日付", "作成日"],
  customerName: ["取引先名", "取引先", "宛名", "顧客名", "会社名"],
  subject: ["件名", "タイトル", "摘要"],
  subtotal: ["小計", "税抜金額", "税抜合計"],
  tax: ["消費税", "消費税額", "税額"],
  total: ["合計金額", "合計", "総額", "金額", "税込金額", "税込合計"],
  dueDate: ["支払期限", "お支払期限", "振込期限", "有効期限"],
};

function normalizeDate(value: string): string | null {
  const m =
    /^(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})/.exec(value.trim()) ??
    null;
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function parseAmount(value: string | undefined): number | null {
  if (value === undefined) return null;
  const cleaned = value.replace(/[¥￥,，\s円]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** ヘッダー行から列位置を推定し、行を MisocaDocRow に変換する */
export function mapMisocaRows(rows: string[][]): { docs: MisocaDocRow[]; skipped: number } {
  if (rows.length < 2) return { docs: [], skipped: 0 };
  const header = rows[0].map((h) => h.trim());
  const colIndex = (key: keyof MisocaDocRow): number =>
    header.findIndex((h) => COLUMN_CANDIDATES[key].some((c) => h === c || h.includes(c)));

  const idx = {
    docNumber: colIndex("docNumber"),
    issueDate: colIndex("issueDate"),
    customerName: colIndex("customerName"),
    subject: colIndex("subject"),
    subtotal: colIndex("subtotal"),
    tax: colIndex("tax"),
    total: colIndex("total"),
    dueDate: colIndex("dueDate"),
  };
  if (idx.total === -1 || idx.issueDate === -1) {
    throw new Error(
      `CSVの列を認識できません（必要: 発行日・合計金額。見つかった列: ${header.join(", ")}）`,
    );
  }

  const docs: MisocaDocRow[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const issueDate = normalizeDate(row[idx.issueDate] ?? "");
    const total = parseAmount(row[idx.total]);
    if (!issueDate || total === null) {
      skipped++;
      continue;
    }
    docs.push({
      docNumber: (idx.docNumber >= 0 ? row[idx.docNumber] : "").trim(),
      issueDate,
      customerName: (idx.customerName >= 0 ? row[idx.customerName] : "").trim(),
      subject: (idx.subject >= 0 ? row[idx.subject] : "").trim(),
      subtotal: idx.subtotal >= 0 ? parseAmount(row[idx.subtotal]) : null,
      tax: idx.tax >= 0 ? parseAmount(row[idx.tax]) : null,
      dueDate: idx.dueDate >= 0 ? normalizeDate(row[idx.dueDate] ?? "") : null,
      total,
    });
  }
  return { docs, skipped };
}

/** インポート実行。番号・金額は Misoca の値をそのまま保存（重複番号はスキップ） */
export async function importMisocaDocuments(
  db: DbPort,
  ctx: AuditContext,
  docType: DocType,
  docs: MisocaDocRow[],
): Promise<{ imported: number; duplicates: number }> {
  if (!DOC_TYPES[docType]) throw new Error(`不正な帳票種別です: ${docType}`);

  const existing = await db.findMany(
    "billing_documents",
    { organization_id: ctx.organizationId, doc_type: docType, source: "misoca" },
    5000,
  );
  const existingNumbers = new Set(existing.map((d) => d.doc_number as string));

  let imported = 0;
  let duplicates = 0;
  for (const doc of docs) {
    const number = doc.docNumber || `MISOCA-${doc.issueDate}-${doc.customerName || "不明"}`;
    if (existingNumbers.has(number)) {
      duplicates++;
      continue;
    }
    existingNumbers.add(number);

    const month = doc.issueDate.slice(0, 7);
    const sameMonth = await db.findMany(
      "billing_documents",
      { organization_id: ctx.organizationId, doc_type: docType, month },
      2000,
    );
    const seq = sameMonth.reduce((max, d) => Math.max(max, Number(d.seq) || 0), 0) + 1;

    const subtotal = doc.subtotal ?? (doc.tax !== null ? doc.total - doc.tax : doc.total);
    const tax = doc.tax ?? (doc.subtotal !== null ? doc.total - doc.subtotal : 0);
    const taxRate = subtotal > 0 ? Math.round((tax / subtotal) * 100) : 0;

    const inserted = await db.insert("billing_documents", {
      organization_id: ctx.organizationId,
      order_id: null,
      source_document_id: null,
      source: "misoca",
      doc_type: docType,
      month,
      seq,
      doc_number: number,
      title: `${number}_${doc.customerName || "帳票"}_${DOC_TYPES[docType].label}（Misoca）`,
      issue_date: doc.issueDate,
      due_date: doc.dueDate,
      customer_name: doc.customerName || null,
      customer_address: null,
      honorific: "様",
      items: [
        {
          name: doc.subject || "（Misocaより移行・明細は原本参照）",
          quantity: "1式",
          unit_price: null,
          amount: doc.total,
        },
      ],
      subtotal,
      tax_rate: [0, 8, 10].includes(taxRate) ? taxRate : 10,
      tax_amount: tax,
      total: doc.total,
      note: "Misocaからインポート（金額はMisocaの値をそのまま保持）",
      issuer: null,
      created_by: ctx.actorId,
    });
    imported++;

    await writeAuditLog(db, ctx, {
      action: "insert",
      tableName: "billing_documents",
      recordId: inserted.id as string,
      after: inserted,
      note: `Misocaインポート ${DOC_TYPES[docType].label} ${number}`,
    });
  }
  return { imported, duplicates };
}
