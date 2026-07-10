import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/**
 * 帳票サービス（請求書 / 納品書 / 領収書）。
 *
 * - 番号は「種類ごと・月ごと」の自動採番（INV-202607-001 形式）
 * - 発行時点の明細・金額・発行者情報をスナップショット保存する
 *   （後から注文・マスタ・設定が変わっても、発行済み帳票は変わらない）
 * - 金額は既存 orders / order_items の値を税込として扱い、内消費税を逆算する
 */

export const DOC_TYPES = {
  invoice: { label: "請求書", prefix: "INV" },
  delivery_note: { label: "納品書", prefix: "DN" },
  receipt: { label: "領収書", prefix: "RC" },
} as const;
export type DocType = keyof typeof DOC_TYPES;

export interface Issuer {
  name: string;
  postal: string;
  address: string;
  phone: string;
  registrationNumber: string; // 適格請求書発行事業者登録番号（空なら非表示）
  bankInfo: string; // 振込先（請求書用）
}

export interface DocumentItem {
  name: string;
  quantity: string; // "2.5kg" など表示用
  unit_price: number | null;
  amount: number;
}

export interface IssueDocumentInput {
  orderId: string;
  docType: DocType;
  title?: string; // ファイル名（空なら自動: 番号_顧客名_種類）
  issueDate: string; // "2026-07-10"
  dueDate?: string | null;
  taxRate?: number; // 8（食品・軽減税率）/ 10 / 0
  note?: string;
  issuer: Issuer;
}

/** 税込金額から内消費税を逆算（切り捨て） */
export function includedTax(totalInclusive: number, taxRate: number): number {
  if (taxRate <= 0) return 0;
  return Math.floor((totalInclusive * taxRate) / (100 + taxRate));
}

export async function issueDocument(
  db: DbPort,
  ctx: AuditContext,
  input: IssueDocumentInput,
): Promise<Row> {
  if (!DOC_TYPES[input.docType]) throw new Error(`不正な帳票種別です: ${input.docType}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.issueDate)) throw new Error("発行日を入力してください");

  const order = await db.findById("orders", input.orderId);
  if (!order) throw new Error(`注文が見つかりません: ${input.orderId}`);
  const orderItems = await db.findMany("order_items", { order_id: input.orderId }, 200);

  const items: DocumentItem[] = orderItems.map((item) => {
    const weight = Number(item.weight_kg ?? item.weight) || 0;
    return {
      name: `${item.species ? `${item.species} ` : ""}${item.part_name ?? ""}`.trim(),
      quantity: weight ? `${weight}kg` : "1式",
      unit_price: item.unit_price === null || item.unit_price === undefined ? null : Number(item.unit_price),
      amount: Number(item.subtotal ?? item.amount) || 0,
    };
  });

  const total =
    Number(order.total_amount) || items.reduce((sum, item) => sum + item.amount, 0);
  const taxRate = input.taxRate ?? 8;
  const taxAmount = includedTax(total, taxRate);

  // 月ごと・種類ごとの自動採番
  const month = input.issueDate.slice(0, 7);
  const sameMonth = await db.findMany(
    "billing_documents",
    { organization_id: ctx.organizationId, doc_type: input.docType, month },
    1000,
  );
  const seq = sameMonth.reduce((max, doc) => Math.max(max, Number(doc.seq) || 0), 0) + 1;
  const docNumber = `${DOC_TYPES[input.docType].prefix}-${month.replace("-", "")}-${String(seq).padStart(3, "0")}`;

  const customerName = (order.customer_name as string) || "";
  const title =
    input.title?.trim() ||
    `${docNumber}_${customerName || "帳票"}_${DOC_TYPES[input.docType].label}`;

  const defaultNote =
    input.docType === "receipt" ? "但し ジビエ肉代として、上記正に領収いたしました" : "";

  const doc = await db.insert("billing_documents", {
    organization_id: ctx.organizationId,
    order_id: input.orderId,
    doc_type: input.docType,
    month,
    seq,
    doc_number: docNumber,
    title,
    issue_date: input.issueDate,
    due_date: input.dueDate || null,
    customer_name: customerName,
    customer_address:
      [order.delivery_postal, order.delivery_address, order.delivery_building]
        .filter(Boolean)
        .join(" ") || null,
    honorific: "様",
    items,
    subtotal: total - taxAmount,
    tax_rate: taxRate,
    tax_amount: taxAmount,
    total,
    note: input.note?.trim() || defaultNote || null,
    issuer: input.issuer,
    created_by: ctx.actorId,
  });

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "billing_documents",
    recordId: doc.id as string,
    after: doc,
    note: `${DOC_TYPES[input.docType].label}発行 ${docNumber}（${customerName}）`,
  });

  return doc;
}

/** 発行済み帳票の取消（ソフトデリート。番号は欠番として残す＝再利用しない） */
export async function voidDocument(db: DbPort, ctx: AuditContext, docId: string): Promise<Row> {
  const before = await db.findById("billing_documents", docId);
  if (!before) throw new Error(`帳票が見つかりません: ${docId}`);
  if (before.deleted_at) throw new Error("すでに取消済みです");
  const after = await db.update("billing_documents", docId, {
    deleted_at: new Date().toISOString(),
  });
  await writeAuditLog(db, ctx, {
    action: "delete",
    tableName: "billing_documents",
    recordId: docId,
    before,
    after,
    note: `帳票取消 ${before.doc_number}`,
  });
  return after;
}
