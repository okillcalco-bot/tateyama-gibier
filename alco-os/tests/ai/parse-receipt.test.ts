import { describe, it, expect } from "vitest";
import { parseReceipt, withRequiredFieldChecks } from "@/ai/workflows/parse-receipt";
import { receiptOutputSchema } from "@/ai/schemas/receipt.schema";
import { MockProvider } from "@/ai/providers/mock-provider";
import { InMemoryDb } from "../helpers/in-memory-db";

const ORG = "org-1";
const IMAGE = [{ mediaType: "image/jpeg" as const, base64: "dGVzdA==" }];

function ctx(db: InMemoryDb, provider = new MockProvider()) {
  return { db, provider, organizationId: ORG, userId: "user-1" };
}

describe("parse_receipt（レシート読み取り）", () => {
  it("読み取り結果はドラフトに入り、経費はまだ作られない", async () => {
    const db = new InMemoryDb();
    const result = await parseReceipt(ctx(db), { hint: "解体室の消耗品", today: "2026-08-06" }, IMAGE, {
      fileId: "file-1",
    });

    expect(result.output.amount).toBe(3480);
    const drafts = await db.findMany("generated_drafts", { status: "draft" });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].draft_type).toBe("receipt_result");
    expect(drafts[0].source_id).toBe("file-1");
    // 確定登録は人が画面で行う
    expect(await db.findMany("expenses", {})).toHaveLength(0);
  });

  it("ai_runs に金額・店名を書かない（要約のみ）", async () => {
    const db = new InMemoryDb();
    await parseReceipt(ctx(db), { hint: "軽トラの燃料", today: "2026-08-06" }, IMAGE);

    const runs = await db.findMany("ai_runs", { workflow: "parse_receipt" });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("succeeded");
    expect(String(runs[0].input_summary)).not.toContain("3480");
    expect(String(runs[0].input_summary)).not.toContain("カインズ");
  });

  it("写真がなければ実行しない", async () => {
    const db = new InMemoryDb();
    await expect(parseReceipt(ctx(db), { hint: "", today: "" }, [])).rejects.toThrow("写真");
    expect(await db.findMany("ai_runs", {})).toHaveLength(0);
  });

  it("必須3項目が欠けていたら、AIの申告に関係なく要確認にする", () => {
    const output = withRequiredFieldChecks(
      receiptOutputSchema.parse({ expense_date: null, amount: 0, vendor: "  " }),
    );
    expect(output.uncertain_fields).toEqual(
      expect.arrayContaining(["expense_date", "amount", "vendor"]),
    );
  });

  it("3項目が読めていれば要確認を増やさない", () => {
    const output = withRequiredFieldChecks(
      receiptOutputSchema.parse({
        expense_date: "2026-08-05",
        amount: 3480,
        vendor: "カインズ館山店",
        uncertain_fields: ["invoice_number"],
      }),
    );
    expect(output.uncertain_fields).toEqual(["invoice_number"]);
  });

  it("AIが金額を落としても、ドラフトには要確認として残る", async () => {
    const db = new InMemoryDb();
    const provider = new MockProvider({
      parse_receipt: JSON.stringify({
        expense_date: "2026-08-05",
        amount: null,
        vendor: "手書きの領収書",
        uncertain_fields: [],
      }),
    });
    const result = await parseReceipt(ctx(db, provider), { hint: "", today: "2026-08-06" }, IMAGE);
    expect(result.output.uncertain_fields).toContain("amount");
  });
});
