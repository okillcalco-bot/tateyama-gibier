import { describe, it, expect, beforeEach } from "vitest";
import {
  listChannelRegistry,
  recordChannelSighting,
} from "@/domain/hunters/line-channel-registry";
import { InMemoryDb } from "../helpers/in-memory-db";

/**
 * チャネル台帳。
 * Bot User ID（destination）は「あとから確認するため」に記録するだけで、
 * ルーティングには使わない。未取得でも運用できることを固定する。
 */

const ORG = "org-1";

describe("LINEチャネル台帳", () => {
  let db: InMemoryDb;

  beforeEach(() => {
    db = new InMemoryDb();
  });

  it("初回受信で destination を自動記録する", async () => {
    await recordChannelSighting(db, {
      organizationId: ORG,
      channelKey: "hunter",
      channelRef: "channel:hunter",
      destination: "U1234567890abcdef",
    });

    const rows = await listChannelRegistry(db, ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0].destination).toBe("U1234567890abcdef");
    expect(rows[0].channel_ref).toBe("channel:hunter");
    expect(rows[0].event_count).toBe(1);
  });

  it("2回目以降は受信回数と最終受信だけ増える（行は増えない）", async () => {
    for (let i = 0; i < 3; i++) {
      await recordChannelSighting(db, {
        organizationId: ORG,
        channelKey: "hunter",
        channelRef: "channel:hunter",
        destination: "U1234567890abcdef",
      });
    }
    const rows = await listChannelRegistry(db, ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_count).toBe(3);
  });

  it("destination が読めなくても記録は作られる（運用を止めない）", async () => {
    await recordChannelSighting(db, {
      organizationId: ORG,
      channelKey: "secretary",
      channelRef: "channel:secretary",
      destination: null,
    });
    const rows = await listChannelRegistry(db, ORG);
    expect(rows[0].destination).toBeNull();
  });

  it("あとから destination が取れたら記録される", async () => {
    await recordChannelSighting(db, {
      organizationId: ORG,
      channelKey: "hunter",
      channelRef: "channel:hunter",
      destination: null,
    });
    await recordChannelSighting(db, {
      organizationId: ORG,
      channelKey: "hunter",
      channelRef: "channel:hunter",
      destination: "Uabc",
    });
    const rows = await listChannelRegistry(db, ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0].destination).toBe("Uabc");
  });

  it("チャネルごとに1行（秘書と捕獲者は別）", async () => {
    await recordChannelSighting(db, {
      organizationId: ORG,
      channelKey: "hunter",
      channelRef: "channel:hunter",
      destination: "Uhunter",
    });
    await recordChannelSighting(db, {
      organizationId: ORG,
      channelKey: "secretary",
      channelRef: "channel:secretary",
      destination: "Usecretary",
    });
    expect(await listChannelRegistry(db, ORG)).toHaveLength(2);
  });
});
