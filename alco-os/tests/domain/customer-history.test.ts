import { describe, it, expect } from "vitest";
import {
  summarizeByCustomer,
  overallSummary,
  toTransaction,
} from "@/domain/billing/customer-history";

const TODAY = "2026-08-06";

const rows = [
  // A社: 30日おきに3回。最終が6日前 → 音沙汰なしではない
  { id: "1", customer_name: "A社", doc_number: "INV-1", doc_type: "invoice", issue_date: "2026-06-01", total: 10000, source: "misoca", note: "Misocaからインポート / 入金済" },
  { id: "2", customer_name: "A社", doc_number: "INV-2", doc_type: "invoice", issue_date: "2026-07-01", total: 20000, source: "misoca", note: "Misocaからインポート / 未入金" },
  { id: "3", customer_name: "A社", doc_number: "INV-3", doc_type: "invoice", issue_date: "2026-07-31", total: 30000, source: "misoca", note: "Misocaからインポート / 未入金" },
  // B社: 2回だが最終が半年前 → しばらく取引なし
  { id: "4", customer_name: "B社", doc_number: "INV-4", doc_type: "invoice", issue_date: "2026-01-05", total: 5000, source: "misoca", note: "入金済" },
  { id: "5", customer_name: "B社", doc_number: "INV-5", doc_type: "invoice", issue_date: "2026-02-05", total: 5000, source: "misoca", note: "入金済" },
  // C社: 1回だけ（平均間隔は出ない）
  { id: "6", customer_name: "C社", doc_number: "INV-6", doc_type: "invoice", issue_date: "2026-08-01", total: 1000, source: "alco", note: null },
  // 取消済み（金額に数えないが履歴には残す）
  { id: "7", customer_name: "C社", doc_number: "INV-7", doc_type: "invoice", issue_date: "2026-08-02", total: 9999, source: "alco", note: null, deleted_at: "2026-08-03" },
  // 取引先名なしは無視
  { id: "8", customer_name: "", doc_number: "INV-8", doc_type: "invoice", issue_date: "2026-08-01", total: 500, source: "alco", note: null },
];

describe("顧客ごとの取引履歴", () => {
  const summaries = summarizeByCustomer(rows, TODAY);

  it("取引先ごとに件数・合計・初回・最終をまとめる（金額の大きい順）", () => {
    expect(summaries.map((c) => c.customerName)).toEqual(["A社", "B社", "C社"]);
    const a = summaries[0];
    expect(a.count).toBe(3);
    expect(a.total).toBe(60000);
    expect(a.firstDate).toBe("2026-06-01");
    expect(a.lastDate).toBe("2026-07-31");
    expect(a.averageIntervalDays).toBe(30);
    expect(a.daysSinceLast).toBe(6);
    expect(a.overdue).toBe(false);
  });

  it("ふだんの間隔を大きく超えたら「しばらく取引なし」にする", () => {
    const b = summaries.find((c) => c.customerName === "B社")!;
    expect(b.averageIntervalDays).toBe(31);
    expect(b.daysSinceLast).toBeGreaterThan(31 * 1.5);
    expect(b.overdue).toBe(true);
  });

  it("1回だけの取引先では間隔を出さない（誤った判定をしない）", () => {
    const c = summaries.find((x) => x.customerName === "C社")!;
    expect(c.averageIntervalDays).toBeNull();
    expect(c.overdue).toBe(false);
  });

  it("取消済みは金額に数えないが、履歴には残す", () => {
    const c = summaries.find((x) => x.customerName === "C社")!;
    expect(c.count).toBe(1);
    expect(c.total).toBe(1000);
    expect(c.transactions).toHaveLength(2);
    expect(c.transactions.some((t) => t.cancelled)).toBe(true);
  });

  it("未入金を件数と金額で拾う", () => {
    const a = summaries.find((x) => x.customerName === "A社")!;
    expect(a.unpaidCount).toBe(2);
    expect(a.unpaidTotal).toBe(50000);
    const overall = overallSummary(summaries);
    expect(overall.customerCount).toBe(3);
    expect(overall.unpaidCount).toBe(2);
    expect(overall.overdueCount).toBe(1);
  });

  it("取引先名が空の行は集計しない", () => {
    expect(summaries.some((c) => c.customerName === "")).toBe(false);
  });

  it("note から未入金を判定する", () => {
    expect(toTransaction({ id: "x", note: "Misocaからインポート / 未入金" }).unpaid).toBe(true);
    expect(toTransaction({ id: "x", note: "Misocaからインポート / 入金済" }).unpaid).toBe(false);
    expect(toTransaction({ id: "x", note: null }).unpaid).toBe(false);
  });
});
