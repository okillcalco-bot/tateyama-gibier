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
  quote: { label: "見積書", prefix: "QT" },
  delivery_note: { label: "納品書", prefix: "DN" },
  invoice: { label: "請求書", prefix: "INV" },
  receipt: { label: "領収書", prefix: "RC" },
} as const;
export type DocType = keyof typeof DOC_TYPES;

/** Misoca流の変換先（見積→納品/請求、納品→請求、請求→領収） */
export const CONVERT_TARGETS: Record<DocType, DocType[]> = {
  quote: ["delivery_note", "invoice"],
  delivery_note: ["invoice"],
  invoice: ["receipt"],
  receipt: [],
};

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

  return insertDocument(db, ctx, {
    docType: input.docType,
    orderId: input.orderId,
    title: input.title,
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    taxRate: input.taxRate ?? 8,
    note: input.note,
    customerName: (order.customer_name as string) || "",
    customerAddress:
      [order.delivery_postal, order.delivery_address, order.delivery_building]
        .filter(Boolean)
        .join(" ") || null,
    items,
    total,
    issuer: input.issuer,
  });
}

/** 帳票の共通発行処理（採番・スナップショット・監査ログ） */
async function insertDocument(
  db: DbPort,
  ctx: AuditContext,
  params: {
    docType: DocType;
    orderId?: string | null;
    sourceDocumentId?: string | null;
    source?: string;
    title?: string;
    issueDate: string;
    dueDate?: string | null;
    taxRate: number;
    note?: string;
    customerName: string;
    customerAddress?: string | null;
    items: DocumentItem[];
    total: number;
    issuer: Issuer | Row;
  },
): Promise<Row> {
  const taxAmount = includedTax(params.total, params.taxRate);

  // 月ごと・種類ごとの自動採番
  const month = params.issueDate.slice(0, 7);
  const sameMonth = await db.findMany(
    "billing_documents",
    { organization_id: ctx.organizationId, doc_type: params.docType, month },
    1000,
  );
  const seq = sameMonth.reduce((max, doc) => Math.max(max, Number(doc.seq) || 0), 0) + 1;
  const docNumber = `${DOC_TYPES[params.docType].prefix}-${month.replace("-", "")}-${String(seq).padStart(3, "0")}`;

  const title =
    params.title?.trim() ||
    `${docNumber}_${params.customerName || "帳票"}_${DOC_TYPES[params.docType].label}`;
  const defaultNote =
    params.docType === "receipt" ? "但し ジビエ肉代として、上記正に領収いたしました" : "";

  const doc = await db.insert("billing_documents", {
    organization_id: ctx.organizationId,
    order_id: params.orderId ?? null,
    source_document_id: params.sourceDocumentId ?? null,
    source: params.source ?? "alco",
    doc_type: params.docType,
    month,
    seq,
    doc_number: docNumber,
    title,
    issue_date: params.issueDate,
    due_date: params.dueDate || null,
    customer_name: params.customerName,
    customer_address: params.customerAddress || null,
    honorific: "様",
    items: params.items,
    subtotal: params.total - taxAmount,
    tax_rate: params.taxRate,
    tax_amount: taxAmount,
    total: params.total,
    note: params.note?.trim() || defaultNote || null,
    issuer: params.issuer,
    created_by: ctx.actorId,
  });

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "billing_documents",
    recordId: doc.id as string,
    after: doc,
    note: `${DOC_TYPES[params.docType].label}発行 ${docNumber}（${params.customerName}）`,
  });

  return doc;
}

export interface ManualItemInput {
  name: string;
  quantity: string;
  unitPrice: number | null;
  amount: number;
}

export interface ManualDocumentInput {
  docType: DocType;
  title?: string;
  issueDate: string;
  dueDate?: string | null; // 請求書=支払期限 / 見積書=有効期限
  taxRate?: number;
  note?: string;
  customerName: string;
  customerAddress?: string;
  items: ManualItemInput[];
  issuer: Issuer;
}

/** 注文に紐づかない自由入力の帳票発行（Misoca型。見積書はこちらのみ） */
export async function issueManualDocument(
  db: DbPort,
  ctx: AuditContext,
  input: ManualDocumentInput,
): Promise<Row> {
  if (!DOC_TYPES[input.docType]) throw new Error(`不正な帳票種別です: ${input.docType}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.issueDate)) throw new Error("発行日を入力してください");
  if (!input.customerName.trim()) throw new Error("宛名を入力してください");

  const items: DocumentItem[] = input.items
    .filter((item) => item.name.trim() && Number.isFinite(item.amount))
    .map((item) => ({
      name: item.name.trim(),
      quantity: item.quantity.trim() || "1",
      unit_price: item.unitPrice,
      amount: Math.round(item.amount),
    }));
  if (!items.length) throw new Error("明細を1行以上入力してください");
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  if (total <= 0) throw new Error("合計金額が0円です。明細の金額を確認してください");

  return insertDocument(db, ctx, {
    docType: input.docType,
    title: input.title,
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    taxRate: input.taxRate ?? 8,
    note: input.note,
    customerName: input.customerName.trim(),
    customerAddress: input.customerAddress?.trim() || null,
    items,
    total,
    issuer: input.issuer,
  });
}

/** 書類変換（Misoca流: 見積→納品/請求、納品→請求、請求→領収）。明細・宛名を引き継ぐ */
export async function convertDocument(
  db: DbPort,
  ctx: AuditContext,
  sourceDocId: string,
  targetType: DocType,
  issueDate: string,
): Promise<Row> {
  const source = await db.findById("billing_documents", sourceDocId);
  if (!source) throw new Error(`変換元の帳票が見つかりません: ${sourceDocId}`);
  if (source.deleted_at) throw new Error("取消済みの帳票は変換できません");
  const allowed = CONVERT_TARGETS[source.doc_type as DocType] ?? [];
  if (!allowed.includes(targetType)) {
    throw new Error(
      `${DOC_TYPES[source.doc_type as DocType]?.label}から${DOC_TYPES[targetType]?.label}への変換はできません`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) throw new Error("発行日を入力してください");

  return insertDocument(db, ctx, {
    docType: targetType,
    orderId: (source.order_id as string) ?? null,
    sourceDocumentId: sourceDocId,
    issueDate,
    taxRate: Number(source.tax_rate) || 8,
    note: targetType === "receipt" ? undefined : (source.note as string) ?? undefined,
    customerName: (source.customer_name as string) ?? "",
    customerAddress: (source.customer_address as string) ?? null,
    items: (source.items as DocumentItem[]) ?? [],
    total: Number(source.total) || 0,
    issuer: (source.issuer as Row) ?? {},
  });
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
