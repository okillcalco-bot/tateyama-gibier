import { describe, it, expect } from "vitest";
import {
  issueDocument,
  voidDocument,
  includedTax,
  type Issuer,
} from "@/domain/billing/billing-service";
import { InMemoryDb } from "../helpers/in-memory-db";

const CTX = { organizationId: "org-1", actorId: "user-1" };
const ISSUER: Issuer = {
  name: "館山ジビエセンター",
  postal: "294-0014",
  address: "千葉県館山市西長田1163-5",
  phone: "0470-00-0000",
  registrationNumber: "",
  bankInfo: "◯◯銀行 ◯◯支店 普通 1234567",
};

async function seedOrder(db: InMemoryDb, total = 10800) {
  const order = await db.insert("orders", {
    order_code: "ORD-1",
    customer_name: "テスト商店",
    total_amount: total,
    delivery_postal: "294-0000",
    delivery_address: "千葉県館山市1-1",
  });
  await db.insert("order_items", {
    order_id: order.id,
    species: "イノシシ",
    part_name: "ロース",
    weight_kg: 2,
    unit_price: 5400,
    subtotal: total,
  });
  return order;
}

describe("billing-service（請求書 / 納品書 / 領収書）", () => {
  it("内税の消費税逆算（切り捨て）", () => {
    expect(includedTax(10800, 8)).toBe(800);
    expect(includedTax(11000, 10)).toBe(1000);
    expect(includedTax(10000, 0)).toBe(0);
  });

  it("月ごと・種類ごとに自動採番される", async () => {
    const db = new InMemoryDb();
    const order = await seedOrder(db);
    const base = { orderId: order.id as string, issuer: ISSUER };

    const inv1 = await issueDocument(db, CTX, { ...base, docType: "invoice", issueDate: "2026-07-10" });
    const inv2 = await issueDocument(db, CTX, { ...base, docType: "invoice", issueDate: "2026-07-15" });
    const dn1 = await issueDocument(db, CTX, { ...base, docType: "delivery_note", issueDate: "2026-07-10" });
    const inv3 = await issueDocument(db, CTX, { ...base, docType: "invoice", issueDate: "2026-08-01" });

    expect(inv1.doc_number).toBe("INV-202607-001");
    expect(inv2.doc_number).toBe("INV-202607-002"); // 同月・同種は連番
    expect(dn1.doc_number).toBe("DN-202607-001"); // 種類が違えば別系列
    expect(inv3.doc_number).toBe("INV-202608-001"); // 月が変われば1から
  });

  it("ファイル名は任意入力、空なら自動生成", async () => {
    const db = new InMemoryDb();
    const order = await seedOrder(db);
    const named = await issueDocument(db, CTX, {
      orderId: order.id as string,
      docType: "receipt",
      title: "7月分 テスト商店様 領収書",
      issueDate: "2026-07-10",
      issuer: ISSUER,
    });
    expect(named.title).toBe("7月分 テスト商店様 領収書");

    const auto = await issueDocument(db, CTX, {
      orderId: order.id as string,
      docType: "invoice",
      issueDate: "2026-07-10",
      issuer: ISSUER,
    });
    expect(auto.title).toBe("INV-202607-001_テスト商店_請求書");
  });

  it("発行時に明細・金額・発行者をスナップショットし、監査ログを残す", async () => {
    const db = new InMemoryDb();
    const order = await seedOrder(db, 10800);
    const doc = await issueDocument(db, CTX, {
      orderId: order.id as string,
      docType: "invoice",
      issueDate: "2026-07-10",
      taxRate: 8,
      issuer: ISSUER,
    });

    expect(doc.total).toBe(10800);
    expect(doc.tax_amount).toBe(800);
    expect(doc.subtotal).toBe(10000);
    const items = doc.items as { name: string; quantity: string }[];
    expect(items[0].name).toBe("イノシシ ロース");
    expect(items[0].quantity).toBe("2kg");
    expect((doc.issuer as Issuer).name).toBe("館山ジビエセンター");

    const logs = await db.findMany("audit_logs", { table_name: "billing_documents" });
    expect(logs).toHaveLength(1);
  });

  it("領収書は但し書きが自動で入り、取消はソフトデリート（番号は欠番）", async () => {
    const db = new InMemoryDb();
    const order = await seedOrder(db);
    const receipt = await issueDocument(db, CTX, {
      orderId: order.id as string,
      docType: "receipt",
      issueDate: "2026-07-10",
      issuer: ISSUER,
    });
    expect(String(receipt.note)).toContain("ジビエ肉代として");

    await voidDocument(db, CTX, receipt.id as string);
    const voided = await db.findById("billing_documents", receipt.id as string);
    expect(voided?.deleted_at).toBeTruthy();

    // 取消後に発行しても番号は再利用されない（欠番として残る）
    const next = await issueDocument(db, CTX, {
      orderId: order.id as string,
      docType: "receipt",
      issueDate: "2026-07-20",
      issuer: ISSUER,
    });
    expect(next.doc_number).toBe("RC-202607-002");
  });
});
