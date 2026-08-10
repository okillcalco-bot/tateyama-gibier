import { describe, it, expect } from "vitest";
import {
  createExpense,
  updateExpense,
  voidExpense,
  summarizeExpenses,
  isValidInvoiceNumber,
  wasCorrected,
} from "@/domain/accounting/expense-service";
import { receiptOutputSchema } from "@/ai/schemas/receipt.schema";
import { InMemoryDb } from "../helpers/in-memory-db";

const CTX = { organizationId: "org-1", actorId: "user-1" };

const base = {
  expenseDate: "2026-08-05",
  amount: 3480,
  vendor: "カインズ館山店",
  category: "消耗品費",
  paymentMethod: "現金",
};

const suggestion = receiptOutputSchema.parse({
  expense_date: "2026-08-05",
  amount: 3480,
  vendor: "カインズ館山店",
});

describe("expense-service（経費・レシート）", () => {
  it("日付・金額・支払先がないと登録できない（電帳法の検索要件）", async () => {
    const db = new InMemoryDb();
    await expect(createExpense(db, CTX, { ...base, expenseDate: "2026/08/05" })).rejects.toThrow(
      "日付",
    );
    await expect(createExpense(db, CTX, { ...base, amount: 0 })).rejects.toThrow("金額");
    await expect(createExpense(db, CTX, { ...base, vendor: "  " })).rejects.toThrow("支払先");
  });

  it("登録すると監査ログが残る", async () => {
    const db = new InMemoryDb();
    const expense = await createExpense(db, CTX, base);
    expect(expense.amount).toBe(3480);
    expect(expense.status).toBe("recorded");
    expect(await db.findMany("audit_logs", { table_name: "expenses" })).toHaveLength(1);
  });

  it("インボイス登録番号は T+13桁のみ（空は許す）", () => {
    expect(isValidInvoiceNumber("")).toBe(true);
    expect(isValidInvoiceNumber("T1234567890123")).toBe(true);
    expect(isValidInvoiceNumber("T123")).toBe(false);
    expect(isValidInvoiceNumber("1234567890123")).toBe(false);
  });

  it("AIの候補と同じなら corrected は false、直したら true", async () => {
    const db = new InMemoryDb();
    const asIs = await createExpense(db, CTX, { ...base, aiSuggestion: suggestion });
    expect(asIs.corrected).toBe(false);

    const fixed = await createExpense(db, CTX, {
      ...base,
      amount: 3840, // 読み間違いを人が直した
      aiSuggestion: suggestion,
    });
    expect(fixed.corrected).toBe(true);
  });

  it("手入力（AI候補なし）は corrected にならない", () => {
    expect(wasCorrected(null, { expenseDate: "2026-08-05", amount: 100, vendor: "店" })).toBe(false);
  });

  it("AI候補は確定値と別に保存される", async () => {
    const db = new InMemoryDb();
    const expense = await createExpense(db, CTX, {
      ...base,
      amount: 3840,
      aiSuggestion: suggestion,
      aiDraftId: "draft-1",
    });
    expect(expense.amount).toBe(3840); // 確定値は人が入れた値
    expect((expense.ai_suggestion as { amount: number }).amount).toBe(3480); // 候補は残る
    expect(expense.ai_draft_id).toBe("draft-1");
  });

  it("登録後に修正でき、履歴が監査ログに残る", async () => {
    const db = new InMemoryDb();
    const expense = await createExpense(db, CTX, { ...base, aiSuggestion: suggestion });
    const updated = await updateExpense(db, CTX, expense.id as string, { amount: 3840 });

    expect(updated.amount).toBe(3840);
    expect(updated.corrected).toBe(true);
    const logs = await db.findMany("audit_logs", { table_name: "expenses" });
    expect(logs.map((l) => l.action)).toEqual(["insert", "update"]);
  });

  it("修正時も不正な値は拒否する", async () => {
    const db = new InMemoryDb();
    const expense = await createExpense(db, CTX, base);
    const id = expense.id as string;
    await expect(updateExpense(db, CTX, id, { amount: -1 })).rejects.toThrow("金額");
    await expect(updateExpense(db, CTX, id, { invoiceNumber: "T1" })).rejects.toThrow("インボイス");
  });

  it("取消はソフトデリート。物理削除しない", async () => {
    const db = new InMemoryDb();
    const expense = await createExpense(db, CTX, base);
    const voided = await voidExpense(db, CTX, expense.id as string, "重複");

    expect(voided.deleted_at).toBeTruthy();
    expect(String(voided.note)).toContain("重複");
    expect(await db.findMany("expenses", {})).toHaveLength(1); // 消えていない
    await expect(updateExpense(db, CTX, expense.id as string, { amount: 100 })).rejects.toThrow(
      "取消済み",
    );
  });

  it("月次サマリは取消分を合計から除き、件数だけ示す", () => {
    const summary = summarizeExpenses([
      { amount: 1000, category: "消耗品費" },
      { amount: 2000, category: "消耗品費" },
      { amount: 5000, category: "燃料費" },
      { amount: 300, category: null },
      { amount: 9999, category: "燃料費", deleted_at: "2026-08-06T00:00:00Z" },
    ]);

    expect(summary.count).toBe(4);
    expect(summary.total).toBe(8300);
    expect(summary.voidedCount).toBe(1);
    expect(summary.byCategory).toEqual([
      { category: "燃料費", count: 1, total: 5000 },
      { category: "消耗品費", count: 2, total: 3000 },
      { category: "未分類", count: 1, total: 300 },
    ]);
  });
});
