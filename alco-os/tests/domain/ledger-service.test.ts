import { describe, it, expect } from "vitest";
import { createSalesSlip, voidSalesSlip } from "@/domain/ledger/ledger-service";
import { InMemoryDb } from "../helpers/in-memory-db";

const CTX = { organizationId: "org-1", actorId: "user-1" };

const base = {
  saleDate: "2026-07-12",
  category: "retail" as const,
  item: "イノシシロース 300g",
  amount: 1800,
  paymentMethod: "cash" as const,
};

describe("ledger-service（売上伝票）", () => {
  it("月毎に自動採番される（SL-YYYYMM-###）", async () => {
    const db = new InMemoryDb();
    const s1 = await createSalesSlip(db, CTX, base);
    const s2 = await createSalesSlip(db, CTX, { ...base, category: "experience", amount: 5000 });
    const s3 = await createSalesSlip(db, CTX, { ...base, saleDate: "2026-08-01" });

    expect(s1.slip_number).toBe("SL-202607-001");
    expect(s2.slip_number).toBe("SL-202607-002"); // 種別が違っても同月は連番
    expect(s3.slip_number).toBe("SL-202608-001"); // 月が変われば1から
  });

  it("登録は監査ログ付き。金額0以下・空品目は拒否", async () => {
    const db = new InMemoryDb();
    await createSalesSlip(db, CTX, base);
    expect(await db.findMany("audit_logs", { table_name: "sales_slips" })).toHaveLength(1);

    await expect(createSalesSlip(db, CTX, { ...base, amount: 0 })).rejects.toThrow("金額");
    await expect(createSalesSlip(db, CTX, { ...base, item: " " })).rejects.toThrow("品目");
    // @ts-expect-error 不正な種別
    await expect(createSalesSlip(db, CTX, { ...base, category: "x" })).rejects.toThrow("種別");
  });

  it("取消はソフトデリートで欠番になる（番号は再利用しない）", async () => {
    const db = new InMemoryDb();
    const slip = await createSalesSlip(db, CTX, base);
    await voidSalesSlip(db, CTX, slip.id as string);

    const voided = await db.findById("sales_slips", slip.id as string);
    expect(voided?.deleted_at).toBeTruthy();

    const next = await createSalesSlip(db, CTX, base);
    expect(next.slip_number).toBe("SL-202607-002"); // 001は欠番のまま
    await expect(voidSalesSlip(db, CTX, slip.id as string)).rejects.toThrow("取消済み");
  });
});
