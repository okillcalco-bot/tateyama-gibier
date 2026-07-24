import { describe, it, expect } from "vitest";
import {
  issueManualDocument,
  convertDocument,
  type Issuer,
} from "@/domain/billing/billing-service";
import { parseCsv, mapMisocaRows, importMisocaDocuments } from "@/domain/billing/misoca-import";
import { InMemoryDb } from "../helpers/in-memory-db";

const CTX = { organizationId: "org-1", actorId: "user-1" };
const ISSUER: Issuer = {
  name: "館山ジビエセンター",
  postal: "294-0014",
  address: "千葉県館山市西長田1163-5",
  phone: "0470-00-0000",
  registrationNumber: "",
  bankInfo: "",
};

describe("帳票センター（Misoca型）", () => {
  it("自由入力で見積書を発行できる（QT採番・明細合計）", async () => {
    const db = new InMemoryDb();
    const quote = await issueManualDocument(db, CTX, {
      docType: "quote",
      issueDate: "2026-07-15",
      dueDate: "2026-08-15",
      customerName: "◯◯レストラン",
      items: [
        { name: "イノシシロース", quantity: "2kg", unitPrice: 5400, amount: 10800 },
        { name: "送料", quantity: "1", unitPrice: null, amount: 1000 },
      ],
      issuer: ISSUER,
    });
    expect(quote.doc_number).toBe("QT-202607-001");
    expect(quote.total).toBe(11800);
    expect(quote.order_id).toBeNull();
  });

  it("書類変換: 見積→請求→領収。明細と宛名を引き継ぎ、系譜が残る", async () => {
    const db = new InMemoryDb();
    const quote = await issueManualDocument(db, CTX, {
      docType: "quote",
      issueDate: "2026-07-15",
      customerName: "◯◯レストラン",
      items: [{ name: "ジビエ肉一式", quantity: "1式", unitPrice: null, amount: 22000 }],
      issuer: ISSUER,
    });

    const invoice = await convertDocument(db, CTX, quote.id as string, "invoice", "2026-07-20");
    expect(invoice.doc_number).toBe("INV-202607-001");
    expect(invoice.total).toBe(22000);
    expect(invoice.customer_name).toBe("◯◯レストラン");
    expect(invoice.source_document_id).toBe(quote.id);

    const receipt = await convertDocument(db, CTX, invoice.id as string, "receipt", "2026-07-25");
    expect(receipt.doc_number).toBe("RC-202607-001");
    expect(String(receipt.note)).toContain("領収");

    // 領収→見積のような逆変換は不可
    await expect(
      convertDocument(db, CTX, receipt.id as string, "quote", "2026-07-26"),
    ).rejects.toThrow("変換はできません");
  });

  it("Misoca CSV: 列名の揺れ・引用符・金額表記を吸収して取り込める", () => {
    const csv =
      '請求書番号,発行日,取引先名,件名,小計,消費税,合計金額\n' +
      '"INV-001",2026/06/01,"株式会社テスト","6月分 ジビエ肉","¥10,000","¥800","¥10,800"\n' +
      'INV-002,2026年6月15日,個人商店,,"5,000",500,"5,500"\n' +
      'BAD,,宛名なし,件名,,,\n';
    const { docs, skipped } = mapMisocaRows(parseCsv(csv));
    expect(docs).toHaveLength(2);
    expect(skipped).toBe(1); // 日付・金額のない行はスキップ
    expect(docs[0]).toMatchObject({
      docNumber: "INV-001",
      issueDate: "2026-06-01",
      customerName: "株式会社テスト",
      total: 10800,
      tax: 800,
    });
    expect(docs[1].issueDate).toBe("2026-06-15");
  });

  it("Misocaインポート: 番号・金額をそのまま保存し、再実行しても重複しない", async () => {
    const db = new InMemoryDb();
    const { docs } = mapMisocaRows(
      parseCsv("請求書番号,発行日,取引先名,合計金額\nM-100,2026/05/01,テスト商店,33000\n"),
    );

    const first = await importMisocaDocuments(db, CTX, "invoice", docs);
    expect(first).toEqual({ imported: 1, duplicates: 0 });
    const second = await importMisocaDocuments(db, CTX, "invoice", docs);
    expect(second).toEqual({ imported: 0, duplicates: 1 });

    const [saved] = await db.findMany("billing_documents", { source: "misoca" });
    expect(saved.doc_number).toBe("M-100"); // Misocaの番号をそのまま保持
    expect(saved.total).toBe(33000);
  });

  it("インポート済みがある月の新規発行は、続きの連番になる", async () => {
    const db = new InMemoryDb();
    const { docs } = mapMisocaRows(
      parseCsv("請求書番号,発行日,取引先名,合計金額\nM-1,2026/07/01,店A,1000\nM-2,2026/07/02,店B,2000\n"),
    );
    await importMisocaDocuments(db, CTX, "invoice", docs);

    const next = await issueManualDocument(db, CTX, {
      docType: "invoice",
      issueDate: "2026-07-20",
      customerName: "店C",
      items: [{ name: "肉", quantity: "1", unitPrice: null, amount: 3000 }],
      issuer: ISSUER,
    });
    expect(next.seq).toBe(3); // インポート分の後ろに続く
  });
});
