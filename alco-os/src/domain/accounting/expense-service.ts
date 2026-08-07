import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";
import type { ReceiptOutput } from "@/ai/schemas/receipt.schema";

/**
 * 経費（レシート）サービス。
 *
 * 流れ: レシートを撮る → AIが候補を出す → **人が確認して登録** → 月ごとに集計・出力
 *
 * 経理の原則:
 * - 物理削除しない。取消はソフトデリート（deleted_at）で欠番として残す
 * - 電子帳簿保存法（スキャナ保存）の検索要件になる「日付・金額・取引先」は必須
 * - AIの読み取り結果は ai_suggestion に候補として残し、確定値とは分けて保存する
 *   （紙の原本を廃棄してよいかは税理士の確認が必要。システムは保証しない）
 */

/** 勘定科目。税理士の指定があればここを直す（画面のプルダウンもここから作る） */
export const EXPENSE_CATEGORIES = [
  "消耗品費",
  "旅費交通費",
  "燃料費",
  "会議費",
  "接待交際費",
  "通信費",
  "水道光熱費",
  "修繕費",
  "荷造運賃",
  "新聞図書費",
  "支払手数料",
  "雑費",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_PAYMENT_METHODS = ["現金", "クレジット", "口座振替", "その他"] as const;

export interface NewExpense {
  expenseDate: string; // "2026-08-05"
  amount: number; // 税込
  vendor: string;
  category?: string;
  paymentMethod?: string;
  taxRate?: number | null;
  taxAmount?: number | null;
  invoiceNumber?: string;
  note?: string;
  items?: unknown;
  receiptFileId?: string | null;
  /** AIの読み取り結果（そのまま保持する。確定値ではない） */
  aiSuggestion?: ReceiptOutput | null;
  aiDraftId?: string | null;
}

/** 適格請求書発行事業者の登録番号（T + 13桁）。空文字は「無し」として許す */
export function isValidInvoiceNumber(value: string): boolean {
  return value === "" || /^T\d{13}$/.test(value);
}

/**
 * AIの候補と、人が登録した値がどれだけ違うかを見る。
 * 「AIをどこまで信じてよいか」を後から測るための記録なので、
 * 検索要件の3項目（日付・金額・取引先）だけを対象にする。
 */
export function wasCorrected(
  suggestion: ReceiptOutput | null | undefined,
  confirmed: { expenseDate: string; amount: number; vendor: string },
): boolean {
  if (!suggestion) return false;
  return (
    suggestion.expense_date !== confirmed.expenseDate ||
    suggestion.amount !== confirmed.amount ||
    suggestion.vendor.trim() !== confirmed.vendor.trim()
  );
}

export async function createExpense(
  db: DbPort,
  ctx: AuditContext,
  input: NewExpense,
): Promise<Row> {
  const expenseDate = input.expenseDate?.trim() ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) {
    throw new Error("日付を入力してください");
  }
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("金額を入力してください");
  }
  const vendor = (input.vendor ?? "").trim();
  if (!vendor) throw new Error("支払先（店名）を入力してください");

  const invoiceNumber = (input.invoiceNumber ?? "").trim();
  if (!isValidInvoiceNumber(invoiceNumber)) {
    throw new Error("インボイス登録番号は T で始まる13桁の数字で入力してください");
  }

  const expense = await db.insert("expenses", {
    organization_id: ctx.organizationId,
    expense_date: expenseDate,
    amount: Math.round(amount),
    vendor,
    category: input.category?.trim() || null,
    payment_method: input.paymentMethod?.trim() || null,
    tax_rate: input.taxRate ?? null,
    tax_amount: input.taxAmount ?? null,
    invoice_number: invoiceNumber || null,
    note: input.note?.trim() || null,
    items: input.items ?? null,
    receipt_file_id: input.receiptFileId ?? null,
    ai_suggestion: input.aiSuggestion ?? null,
    ai_draft_id: input.aiDraftId ?? null,
    corrected: wasCorrected(input.aiSuggestion, { expenseDate, amount, vendor }),
    status: "recorded",
    created_by: ctx.actorId,
  });

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "expenses",
    recordId: expense.id as string,
    after: expense,
  });

  return expense;
}

/** 登録後の修正（金額の打ち間違いなど）。履歴は監査ログに残る */
export async function updateExpense(
  db: DbPort,
  ctx: AuditContext,
  id: string,
  patch: Partial<NewExpense>,
): Promise<Row> {
  const before = await db.findById("expenses", id);
  if (!before) throw new Error("経費が見つかりません");
  if (before.deleted_at) throw new Error("取消済みの経費は編集できません");

  const next: Row = {};
  if (patch.expenseDate !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.expenseDate)) throw new Error("日付を入力してください");
    next.expense_date = patch.expenseDate;
  }
  if (patch.amount !== undefined) {
    const amount = Number(patch.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("金額を入力してください");
    next.amount = Math.round(amount);
  }
  if (patch.vendor !== undefined) {
    const vendor = patch.vendor.trim();
    if (!vendor) throw new Error("支払先（店名）を入力してください");
    next.vendor = vendor;
  }
  if (patch.category !== undefined) next.category = patch.category.trim() || null;
  if (patch.paymentMethod !== undefined) {
    next.payment_method = patch.paymentMethod.trim() || null;
  }
  if (patch.taxRate !== undefined) next.tax_rate = patch.taxRate;
  if (patch.taxAmount !== undefined) next.tax_amount = patch.taxAmount;
  if (patch.invoiceNumber !== undefined) {
    const invoiceNumber = patch.invoiceNumber.trim();
    if (!isValidInvoiceNumber(invoiceNumber)) {
      throw new Error("インボイス登録番号は T で始まる13桁の数字で入力してください");
    }
    next.invoice_number = invoiceNumber || null;
  }
  if (patch.note !== undefined) next.note = patch.note.trim() || null;
  if (Object.keys(next).length === 0) return before;

  // 人が直した事実を残す（AIの精度を後から見るため）
  if (before.ai_suggestion) next.corrected = true;

  const after = await db.update("expenses", id, next);
  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "expenses",
    recordId: id,
    before,
    after,
  });
  return after;
}

/** 取消（物理削除しない）。重複登録・誤登録はこれで消す */
export async function voidExpense(
  db: DbPort,
  ctx: AuditContext,
  id: string,
  reason: string,
): Promise<Row> {
  const before = await db.findById("expenses", id);
  if (!before) throw new Error("経費が見つかりません");
  if (before.deleted_at) return before;

  const after = await db.update("expenses", id, {
    deleted_at: new Date().toISOString(),
    note: [before.note, `【取消】${reason.trim() || "理由未記入"}`].filter(Boolean).join(" / "),
  });
  await writeAuditLog(db, ctx, {
    action: "delete",
    tableName: "expenses",
    recordId: id,
    before,
    after,
    note: `取消: ${reason.trim() || "理由未記入"}`,
  });
  return after;
}

export interface ExpenseSummary {
  count: number;
  total: number;
  byCategory: { category: string; count: number; total: number }[];
  /** 取消済みは金額に数えないが、件数だけ出して「消えていない」ことを示す */
  voidedCount: number;
}

/** 一覧画面の月次サマリ（取消済みは合計から除く） */
export function summarizeExpenses(rows: Row[]): ExpenseSummary {
  const totals = new Map<string, { count: number; total: number }>();
  let count = 0;
  let total = 0;
  let voidedCount = 0;

  for (const row of rows) {
    if (row.deleted_at) {
      voidedCount += 1;
      continue;
    }
    const amount = Number(row.amount) || 0;
    count += 1;
    total += amount;
    const category = (row.category as string) || "未分類";
    const current = totals.get(category) ?? { count: 0, total: 0 };
    totals.set(category, { count: current.count + 1, total: current.total + amount });
  }

  const byCategory = [...totals.entries()]
    .map(([category, value]) => ({ category, ...value }))
    .sort((a, b) => b.total - a.total);

  return { count, total, byCategory, voidedCount };
}
