import { describe, it, expect } from "vitest";
import {
  updateOrderStatus,
  normalizeOrderStatus,
  ORDER_STATUSES,
} from "@/domain/orders/order-service";
import { InMemoryDb } from "../helpers/in-memory-db";

const CTX = { organizationId: "org-1", actorId: "user-1" };

describe("order-service（タノム型受注管理の軸）", () => {
  it("order-portal.html と同じステータス語彙だけを許可する", () => {
    expect(ORDER_STATUSES).toEqual(["受注", "確認済", "発送済", "納品完了", "キャンセル"]);
  });

  it("旧デフォルト「受付」は「受注」に正規化される", () => {
    expect(normalizeOrderStatus("受付")).toBe("受注");
    expect(normalizeOrderStatus(null)).toBe("受注");
    expect(normalizeOrderStatus("確認済")).toBe("確認済");
  });

  it("ステータス変更は監査ログ（before/after付き）を残す", async () => {
    const db = new InMemoryDb();
    const order = await db.insert("orders", {
      order_code: "ORD-1",
      customer_name: "テスト商店",
      status: "受注",
    });

    const after = await updateOrderStatus(db, CTX, order.id as string, "確認済");
    expect(after.status).toBe("確認済");

    const logs = await db.findMany("audit_logs", { table_name: "orders" });
    expect(logs).toHaveLength(1);
    expect(String(logs[0].note)).toContain("受注 → 確認済");
  });

  it("語彙にないステータスは拒否される", async () => {
    const db = new InMemoryDb();
    const order = await db.insert("orders", { order_code: "ORD-2", status: "受注" });
    await expect(
      // @ts-expect-error 不正な値を意図的に渡す
      updateOrderStatus(db, CTX, order.id as string, "出荷済"),
    ).rejects.toThrow("不正なステータス");
  });
});
