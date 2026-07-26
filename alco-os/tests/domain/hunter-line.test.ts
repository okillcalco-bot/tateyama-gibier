import { describe, it, expect, beforeEach } from "vitest";
import { intakeHunterEvent } from "@/domain/hunters/hunter-message-service";
import {
  blockLink,
  createPendingLink,
  findLinkByLineUser,
  unblockLink,
  verifyLink,
} from "@/domain/hunters/hunter-link-service";
import { InMemoryDb } from "../helpers/in-memory-db";

/**
 * 捕獲者チャネルの受信処理。
 * 既存 hunters / individuals には一切書き込まないこと、
 * 承認前に業務データが動かないことを固定する。
 */

const ORG = "org-1";
const CHANNEL = "Udestination-hunter";
const ctx = { organizationId: ORG, actorId: "staff-1" };

function event(overrides: Partial<Parameters<typeof intakeHunterEvent>[1]> = {}) {
  return {
    channelId: CHANNEL,
    channelKey: "hunter",
    webhookEventId: "evt-1",
    eventType: "message",
    messageType: "text",
    lineUserId: "Uhunter-line-user",
    text: "きのう仕掛けた場所の様子を見てきました",
    hasLocation: false,
    ...overrides,
  };
}

/** 呼ばれたら記録するだけの分類スタブ（AIは呼ばない） */
function classifierSpy() {
  const calls: { text: string; hunterName?: string }[] = [];
  return {
    calls,
    classify: async (params: { text: string; hunterName?: string }) => {
      calls.push({ text: params.text, hunterName: params.hunterName });
      return { intent: "delivery_notice" };
    },
  };
}

describe("捕獲者チャネルの受信", () => {
  let db: InMemoryDb;

  beforeEach(() => {
    db = new InMemoryDb();
  });

  it("未登録のLINEユーザーは確認まちのリンクを作り、AIを動かさない", async () => {
    const spy = classifierSpy();
    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG, classify: spy.classify },
      event(),
    );

    expect(outcome.kind).toBe("pending");
    if (outcome.kind !== "pending") throw new Error("unreachable");
    expect(outcome.isNew).toBe(true);
    expect(spy.calls).toHaveLength(0);

    const link = await findLinkByLineUser(db, CHANNEL, "Uhunter-line-user");
    expect(link?.status).toBe("pending");
    expect(link?.hunter_id).toBeNull();
    // 本文は職員が見られるように保存される
    expect(db.tables.get("line_inbound_messages")).toHaveLength(1);
  });

  it("同じ webhookEventId は二重に処理しない（LINEの再送対策）", async () => {
    await intakeHunterEvent({ db, organizationId: ORG }, event());
    const second = await intakeHunterEvent({ db, organizationId: ORG }, event());

    expect(second.kind).toBe("duplicate");
    expect(db.tables.get("line_webhook_events")).toHaveLength(1);
    expect(db.tables.get("line_inbound_messages")).toHaveLength(1);
  });

  it("確認まちのリンクなら、2回目以降もAIを動かさない", async () => {
    const spy = classifierSpy();
    await createPendingLink(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineUserId: "Uhunter-line-user",
    });

    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG, classify: spy.classify },
      event({ webhookEventId: "evt-2" }),
    );

    expect(outcome.kind).toBe("pending");
    if (outcome.kind !== "pending") throw new Error("unreachable");
    expect(outcome.isNew).toBe(false);
    expect(spy.calls).toHaveLength(0);
  });

  it("確認ずみの捕獲者の自由文はAI分類が動き、仕分け結果が保存される", async () => {
    const spy = classifierSpy();
    const hunter = await db.insert("hunters", { name: "山田 太郎", city: "館山市" });
    const link = await createPendingLink(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineUserId: "Uhunter-line-user",
    });
    await verifyLink(db, ctx, { linkId: link.id as string, hunterId: hunter.id as string });

    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG, classify: spy.classify },
      event({ webhookEventId: "evt-3" }),
    );

    expect(outcome.kind).toBe("received");
    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.classified).toBe(true);
    expect(spy.calls[0].hunterName).toBe("山田 太郎");

    const message = await db.findById("line_inbound_messages", outcome.messageId);
    expect(message?.detected_intent).toBe("delivery_notice");
    expect(message?.status).toBe("classified");
    expect(outcome.reply).toContain("受け付けました");
  });

  it("受け取らない設定の相手は保存も分類もしない", async () => {
    const spy = classifierSpy();
    const link = await createPendingLink(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineUserId: "Uhunter-line-user",
    });
    await blockLink(db, ctx, { linkId: link.id as string });

    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG, classify: spy.classify },
      event({ webhookEventId: "evt-4" }),
    );

    expect(outcome.kind).toBe("blocked");
    expect(spy.calls).toHaveLength(0);
    expect(db.tables.get("line_inbound_messages") ?? []).toHaveLength(0);
  });

  it("メッセージ以外のイベント（友だち追加など）は対象外", async () => {
    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG },
      event({ webhookEventId: "evt-5", eventType: "follow", messageType: null, text: null }),
    );
    expect(outcome.kind).toBe("skipped");
    expect(db.tables.get("line_inbound_messages") ?? []).toHaveLength(0);
  });

  it("送信者IDが取れないイベントは対象外", async () => {
    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG },
      event({ webhookEventId: "evt-6", lineUserId: null }),
    );
    expect(outcome.kind).toBe("skipped");
  });

  it("位置情報つきの連絡でも座標は保存しない（docs/10）", async () => {
    const hunter = await db.insert("hunters", { name: "鈴木 花子" });
    const link = await createPendingLink(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineUserId: "Uhunter-line-user",
    });
    await verifyLink(db, ctx, { linkId: link.id as string, hunterId: hunter.id as string });

    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG },
      event({ webhookEventId: "evt-7", messageType: "location", text: null, hasLocation: true }),
    );

    expect(outcome.kind).toBe("received");
    const message = (db.tables.get("line_inbound_messages") ?? [])[0];
    expect(message.has_location).toBe(true);
    expect(message.body).toBeNull();
    // 座標を持つ列そのものを作っていない
    expect(Object.keys(message)).not.toContain("lat");
    expect(Object.keys(message)).not.toContain("lng");
  });

  it("受信処理は既存ジビエ基幹テーブルへ書き込まない", async () => {
    await db.insert("hunters", { name: "既存の捕獲者" });
    const before = (db.tables.get("hunters") ?? []).length;

    await intakeHunterEvent({ db, organizationId: ORG }, event({ webhookEventId: "evt-8" }));

    expect((db.tables.get("hunters") ?? []).length).toBe(before);
    expect(db.tables.get("individuals")).toBeUndefined();
    expect(db.tables.get("orders")).toBeUndefined();
  });
});

describe("捕獲者リンクの管理", () => {
  let db: InMemoryDb;

  beforeEach(() => {
    db = new InMemoryDb();
  });

  it("紐付けは監査ログに残る", async () => {
    const hunter = await db.insert("hunters", { name: "山田 太郎" });
    const link = await createPendingLink(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineUserId: "U1",
    });

    const after = await verifyLink(db, ctx, {
      linkId: link.id as string,
      hunterId: hunter.id as string,
    });

    expect(after.status).toBe("verified");
    expect(after.verified_by).toBe("staff-1");
    expect(db.tables.get("audit_logs")).toHaveLength(1);
  });

  it("捕獲者を選ばずに確認ずみにはできない", async () => {
    const link = await createPendingLink(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineUserId: "U1",
    });
    await expect(
      verifyLink(db, ctx, { linkId: link.id as string, hunterId: "" }),
    ).rejects.toThrow("捕獲者を選んでください");
  });

  it("受け取らない設定のまま紐付けはできない", async () => {
    const link = await createPendingLink(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineUserId: "U1",
    });
    await blockLink(db, ctx, { linkId: link.id as string });
    await expect(
      verifyLink(db, ctx, { linkId: link.id as string, hunterId: "hunter-1" }),
    ).rejects.toThrow(/受け取らない/);
  });

  it("ブロック解除すると、紐付け済みなら確認ずみに戻る", async () => {
    const hunter = await db.insert("hunters", { name: "山田 太郎" });
    const link = await createPendingLink(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineUserId: "U1",
    });
    await verifyLink(db, ctx, { linkId: link.id as string, hunterId: hunter.id as string });
    await blockLink(db, ctx, { linkId: link.id as string });

    const after = await unblockLink(db, ctx, link.id as string);
    expect(after.status).toBe("verified");
  });
});
