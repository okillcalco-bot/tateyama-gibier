import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/**
 * 売上伝票サービス（経理の入口）。
 * 小売の手売り・解体体験・イベント販売など「領収書不要の売上」を
 * スタッフがスマホから記録する。番号は月毎の自動採番（SL-202607-001）。
 * 取消はソフトデリート = 欠番として履歴を残す（経理原則: 削除より保存）。
 * 会計ソフト連携は段階2。まずは月次集計とCSVで税理士に渡せる形を保証する。
 */

export const SLIP_CATEGORIES = {
  retail: "手売り（小売）",
  experience: "解体体験",
  event: "イベント販売",
  shipping: "出荷（その他）",
  other: "その他",
} as const;
export type SlipCategory = keyof typeof SLIP_CATEGORIES;

export const PAYMENT_METHODS = {
  cash: "現金",
  paypay: "PayPay",
  card: "カード",
  transfer: "振込",
  other: "その他",
} as const;
export type PaymentMethod = keyof typeof PAYMENT_METHODS;

export interface NewSalesSlip {
  saleDate: string; // "2026-07-12"
  category: SlipCategory;
  item: string;
  quantity?: number | null;
  amount: number;
  paymentMethod: PaymentMethod;
  staffName?: string;
  note?: string;
  /** 既存ジビエ在庫管理の products.id（品目ピッカーから選んだ場合のトレース用） */
  productId?: string | null;
}

export async function createSalesSlip(
  db: DbPort,
  ctx: AuditContext,
  input: NewSalesSlip,
): Promise<Row> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.saleDate)) throw new Error("日付を入力してください");
  if (!SLIP_CATEGORIES[input.category]) throw new Error(`不正な種別: ${input.category}`);
  if (!PAYMENT_METHODS[input.paymentMethod]) {
    throw new Error(`不正な支払方法: ${input.paymentMethod}`);
  }
  const item = input.item.trim();
  if (!item) throw new Error("品目・内容を入力してください");
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("金額を入力してください");

  // 月毎の自動採番（取消済みも含めて数える = 欠番を再利用しない）
  const month = input.saleDate.slice(0, 7);
  const sameMonth = await db.findMany(
    "sales_slips",
    { organization_id: ctx.organizationId, month },
    2000,
  );
  const seq = sameMonth.reduce((max, slip) => Math.max(max, Number(slip.seq) || 0), 0) + 1;
  const slipNumber = `SL-${month.replace("-", "")}-${String(seq).padStart(3, "0")}`;

  const slip = await db.insert("sales_slips", {
    organization_id: ctx.organizationId,
    month,
    seq,
    slip_number: slipNumber,
    sale_date: input.saleDate,
    category: input.category,
    item,
    quantity: input.quantity ?? null,
    amount,
    payment_method: input.paymentMethod,
    staff_name: input.staffName?.trim() || null,
    note: input.note?.trim() || null,
    product_id: input.productId || null,
    created_by: ctx.actorId,
  });

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "sales_slips",
    recordId: slip.id as string,
    after: slip,
    note: `売上伝票 ${slipNumber}（${SLIP_CATEGORIES[input.category]} ¥${amount.toLocaleString()}）`,
  });
  return slip;
}

/** 伝票の取消（ソフトデリート。番号は欠番として残す） */
export async function voidSalesSlip(db: DbPort, ctx: AuditContext, slipId: string): Promise<Row> {
  const before = await db.findById("sales_slips", slipId);
  if (!before) throw new Error(`伝票が見つかりません: ${slipId}`);
  if (before.deleted_at) throw new Error("すでに取消済みです");
  const after = await db.update("sales_slips", slipId, {
    deleted_at: new Date().toISOString(),
  });
  await writeAuditLog(db, ctx, {
    action: "delete",
    tableName: "sales_slips",
    recordId: slipId,
    before,
    after,
    note: `売上伝票取消 ${before.slip_number}`,
  });
  return after;
}
