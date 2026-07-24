import { describe, it, expect } from "vitest";
import { buildGibierCatalog, priceForRank } from "@/domain/billing/gibier-catalog";
import { createSalesSlip } from "@/domain/ledger/ledger-service";
import { InMemoryDb } from "../helpers/in-memory-db";

const CTX = { organizationId: "org-1", actorId: "user-1" };

const PRODUCTS = [
  { id: "p1", name: "イノシシソーセージ", unit: "パック", price: 800, stock_qty: 12, deleted_at: null },
  { id: "p2", name: "廃止商品", unit: "個", price: 500, stock_qty: 0, deleted_at: "2026-01-01" },
];
const PRICE_MASTER = [
  {
    id: "m1",
    species: "イノシシ",
    part_name: "ロース",
    price_standard: 5400,
    price_premium: 6000,
    price_wholesale: 4300,
  },
  {
    id: "m2",
    species: "シカ",
    part_name: "モモ",
    price_standard: 3000,
    price_premium: 0, // 未設定 → standard にフォールバック
    price_wholesale: 2400,
  },
];

describe("gibier-catalog（在庫管理システムとの品目連携）", () => {
  it("完成品 + 部位単価をカタログ化し、削除済み商品は除外する", () => {
    const catalog = buildGibierCatalog(PRODUCTS, PRICE_MASTER, "standard");
    expect(catalog.map((c) => c.name)).toEqual([
      "イノシシソーセージ",
      "イノシシ ロース",
      "シカ モモ",
    ]);
    expect(catalog[0]).toMatchObject({ kind: "product", productId: "p1", stockQty: 12, price: 800 });
    expect(catalog[1]).toMatchObject({ kind: "part", productId: null, unit: "kg", price: 5400 });
  });

  it("顧客の価格ランクで部位単価が切り替わり、未設定ランクは標準にフォールバック", () => {
    expect(priceForRank(PRICE_MASTER[0], "wholesale")).toBe(4300);
    expect(priceForRank(PRICE_MASTER[0], "premium")).toBe(6000);
    expect(priceForRank(PRICE_MASTER[1], "premium")).toBe(3000); // 0 → standard
    const wholesale = buildGibierCatalog([], PRICE_MASTER, "wholesale");
    expect(wholesale[0].price).toBe(4300);
  });

  it("売上伝票は product_id で在庫管理システムに紐づく（手入力なら null）", async () => {
    const db = new InMemoryDb();
    const linked = await createSalesSlip(db, CTX, {
      saleDate: "2026-07-13",
      category: "retail",
      item: "イノシシソーセージ",
      amount: 800,
      paymentMethod: "cash",
      productId: "p1",
    });
    expect(linked.product_id).toBe("p1");

    const manual = await createSalesSlip(db, CTX, {
      saleDate: "2026-07-13",
      category: "experience",
      item: "解体体験 2名",
      amount: 10000,
      paymentMethod: "paypay",
    });
    expect(manual.product_id).toBeNull();
  });
});
