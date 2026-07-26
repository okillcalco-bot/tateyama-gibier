import { describe, it, expect, beforeEach } from "vitest";
import {
  activateGroup,
  buildDeliveryNoticeMessage,
  disableGroup,
  enableGroupNotify,
  findGroup,
  listNotifyTargets,
  matchGroupCommand,
  recordGroupJoin,
  recordNotified,
  renameGroup,
} from "@/domain/hunters/staff-group-service";
import { InMemoryDb } from "../helpers/in-memory-db";

/**
 * スタッフグループへの搬入連絡の通知（0028）。
 * 守秘義務（買取額・口座・座標を流さない）と誤爆防止を固定する。
 */

const ORG = "org-1";
const CHANNEL = "channel:hunter";
const GROUP = "Cgroup1234";
const ctx = { organizationId: ORG, actorId: "staff-1" };

describe("グループのコマンド（これ以外には反応しない）", () => {
  it("「登録」「解除」だけを拾う", () => {
    expect(matchGroupCommand("登録")).toBe("register");
    expect(matchGroupCommand("通知オン")).toBe("register");
    expect(matchGroupCommand("解除")).toBe("unregister");
    expect(matchGroupCommand("通知停止")).toBe("unregister");
  });

  it("ふつうの会話には反応しない（誤爆防止）", () => {
    expect(matchGroupCommand("おつかれさまです")).toBeNull();
    expect(matchGroupCommand("搬入連絡")).toBeNull();
    expect(matchGroupCommand("捕獲報告")).toBeNull();
    expect(matchGroupCommand("明日の登録どうする？")).toBeNull();
    expect(matchGroupCommand("")).toBeNull();
  });
});

describe("グループの登録と解除", () => {
  let db: InMemoryDb;

  beforeEach(() => {
    db = new InMemoryDb();
  });

  it("招待されただけでは通知しない（pending）", async () => {
    await recordGroupJoin(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineGroupId: GROUP,
    });
    const group = await findGroup(db, GROUP);
    expect(group?.status).toBe("pending");
    expect(group?.notify_delivery).toBe(false);
    expect(await listNotifyTargets(db, ORG)).toHaveLength(0);
  });

  it("「登録」で通知先になる", async () => {
    await activateGroup(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineGroupId: GROUP,
    });
    const targets = await listNotifyTargets(db, ORG);
    expect(targets).toHaveLength(1);
    expect(targets[0].line_group_id).toBe(GROUP);
  });

  it("同じグループを二重に作らない", async () => {
    await recordGroupJoin(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineGroupId: GROUP,
    });
    await activateGroup(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineGroupId: GROUP,
    });
    expect(db.tables.get("line_staff_groups")).toHaveLength(1);
  });

  it("「解除」で通知を止める", async () => {
    await activateGroup(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineGroupId: GROUP,
    });
    await disableGroup(db, { lineGroupId: GROUP, ctx });
    expect(await listNotifyTargets(db, ORG)).toHaveLength(0);
    expect((await findGroup(db, GROUP))?.status).toBe("disabled");
    expect((db.tables.get("audit_logs") ?? []).length).toBeGreaterThan(0);
  });

  it("退出したら通知を止め、職員画面から再開できない", async () => {
    await activateGroup(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineGroupId: GROUP,
    });
    await disableGroup(db, { lineGroupId: GROUP, status: "left" });
    const group = await findGroup(db, GROUP);
    expect(group?.status).toBe("left");
    await expect(enableGroupNotify(db, ctx, group!.id as string)).rejects.toThrow(/招待/);
  });

  it("職員画面から通知を再開できる（監査ログに残る）", async () => {
    await activateGroup(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineGroupId: GROUP,
    });
    const group = await findGroup(db, GROUP);
    await disableGroup(db, { lineGroupId: GROUP });
    const after = await enableGroupNotify(db, ctx, group!.id as string);
    expect(after.notify_delivery).toBe(true);
    expect(await listNotifyTargets(db, ORG)).toHaveLength(1);
  });

  it("名前を付けられる", async () => {
    await activateGroup(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineGroupId: GROUP,
    });
    const group = await findGroup(db, GROUP);
    const after = await renameGroup(db, ctx, {
      groupId: group!.id as string,
      label: "センター スタッフ",
    });
    expect(after.label).toBe("センター スタッフ");
  });

  it("通知の回数と最終通知を記録する", async () => {
    await activateGroup(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineGroupId: GROUP,
    });
    const group = await findGroup(db, GROUP);
    await recordNotified(db, group!.id as string);
    await recordNotified(db, group!.id as string);
    const after = await findGroup(db, GROUP);
    expect(after?.notify_count).toBe(2);
    expect(after?.last_notified_at).toBeTruthy();
  });
});

describe("グループへ流す文面（守秘義務）", () => {
  const receivedAt = new Date("2026-07-27T09:05:00+09:00");

  it("誰から・いつ、までしか出さない", () => {
    const text = buildDeliveryNoticeMessage({
      hunterName: "山田 太郎",
      receivedAt,
      accepting: true,
    });
    expect(text).toContain("搬入の連絡");
    expect(text).toContain("山田 太郎");
    expect(text).toContain("7月27日");
    expect(text).toContain("ALCO OS");
  });

  it("買取額・口座・座標・LINEのIDを含めない", () => {
    const text = buildDeliveryNoticeMessage({
      hunterName: "山田 太郎",
      receivedAt,
      accepting: null,
    });
    // 金額・口座・座標に使う文字が入っていないこと
    expect(text).not.toMatch(/円|口座|振込|銀行/);
    expect(text).not.toMatch(/緯度|経度|\d{2}\.\d{4}/);
    expect(text).not.toMatch(/^U[0-9a-f]{8}/m);
    expect(text).not.toContain("写真");
  });

  it("未照合の相手は名前を出さない", () => {
    const text = buildDeliveryNoticeMessage({
      hunterName: null,
      receivedAt,
      accepting: true,
    });
    expect(text).toContain("お名前の確認まちの方");
  });

  it("受入を止めている日は対応をお願いする一文が入る", () => {
    const text = buildDeliveryNoticeMessage({
      hunterName: "山田 太郎",
      receivedAt,
      accepting: false,
    });
    expect(text).toContain("受け入れを止めています");
  });
});
