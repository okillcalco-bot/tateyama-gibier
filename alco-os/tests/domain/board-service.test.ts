import { describe, it, expect } from "vitest";
import {
  autoTags,
  createBoardPost,
  archiveBoardPost,
  isVisibleToRole,
  isVisibleToTier,
  setCustomerTier,
} from "@/domain/board/board-service";
import { InMemoryDb } from "../helpers/in-memory-db";

const CTX = { organizationId: "org-1", actorId: "user-1" };

describe("board-service（共有ボード）", () => {
  it("本文から自動タグが付く（辞書ベース・重複なし）", () => {
    expect(autoTags("明日の搬入は10時。冷凍庫Bの温度チェックを至急お願いします")).toEqual([
      "至急",
      "精肉・在庫",
      "受注・配送",
      "衛生・清掃",
      "設備・施設",
    ]);
    expect(autoTags("特に何もない日")).toEqual([]);
  });

  it("投稿時に自動タグ + 手動タグがマージされ、監査ログが残る", async () => {
    const db = new InMemoryDb();
    const post = await createBoardPost(db, CTX, {
      audience: "staff",
      title: "シフト変更",
      body: "来週の日勤を1名増やします",
      manualTags: ["7月", "シフト変更"],
      targetRoles: ["解体・精肉"],
    });
    expect(post.tags).toEqual(["勤怠・シフト", "7月", "シフト変更"]);
    expect(post.target_roles).toEqual(["解体・精肉"]);
    expect(post.target_tiers).toEqual([]); // staff向けは tier を持たない
    expect(await db.findMany("audit_logs", { table_name: "board_posts" })).toHaveLength(1);
  });

  it("宛先の可視判定: 空 = 全員/全店、指定ありは一致のみ", () => {
    expect(isVisibleToRole({ target_roles: [] }, null)).toBe(true);
    expect(isVisibleToRole({ target_roles: ["配送"] }, "配送")).toBe(true);
    expect(isVisibleToRole({ target_roles: ["配送"] }, "事務")).toBe(false);
    expect(isVisibleToRole({ target_roles: ["配送"] }, null)).toBe(false);

    expect(isVisibleToTier({ target_tiers: [] }, "new")).toBe(true);
    expect(isVisibleToTier({ target_tiers: ["vip"] }, "vip")).toBe(true);
    expect(isVisibleToTier({ target_tiers: ["vip", "repeat"] }, "new")).toBe(false);
  });

  it("飲食店の信頼度は1店舗1行で upsert され、監査ログが残る", async () => {
    const db = new InMemoryDb();
    await setCustomerTier(db, CTX, "customer-1", "repeat");
    await setCustomerTier(db, CTX, "customer-1", "vip");

    const levels = await db.findMany("customer_levels", { customer_id: "customer-1" });
    expect(levels).toHaveLength(1);
    expect(levels[0].tier).toBe("vip");
    expect(await db.findMany("audit_logs", { table_name: "customer_levels" })).toHaveLength(2);
  });

  it("不正な信頼度・空本文は拒否される", async () => {
    const db = new InMemoryDb();
    await expect(
      createBoardPost(db, CTX, { audience: "customer", body: " ", targetTiers: [] }),
    ).rejects.toThrow("本文");
    await expect(
      // @ts-expect-error 不正値を意図的に渡す
      setCustomerTier(db, CTX, "customer-1", "platinum"),
    ).rejects.toThrow("不正な信頼度");
  });

  it("アーカイブで一覧から外れる（statusのみ変更・削除はしない）", async () => {
    const db = new InMemoryDb();
    const post = await createBoardPost(db, CTX, { audience: "staff", body: "テスト" });
    const archived = await archiveBoardPost(db, CTX, post.id as string);
    expect(archived.status).toBe("archived");
  });
});
