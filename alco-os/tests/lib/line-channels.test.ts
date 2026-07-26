import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * チャネル解決は環境変数に依存するため、毎回モジュールを読み直す。
 * 実際のシークレットは使わない（すべてテスト用のダミー文字列）。
 */

const LINE_ENV_KEYS = [
  "LINE_CHANNEL_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_SECRETARY_CHANNEL_ID",
  "LINE_SECRETARY_CHANNEL_SECRET",
  "LINE_SECRETARY_CHANNEL_ACCESS_TOKEN",
  "LINE_HUNTER_CHANNEL_ID",
  "LINE_HUNTER_CHANNEL_SECRET",
  "LINE_HUNTER_CHANNEL_ACCESS_TOKEN",
  "GAS_WEBHOOK_URL",
];

async function loadChannels(envValues: Record<string, string>) {
  vi.resetModules();
  for (const key of LINE_ENV_KEYS) vi.stubEnv(key, "");
  for (const [key, value] of Object.entries(envValues)) vi.stubEnv(key, value);
  const mod = await import("@/lib/line/channels");
  return mod.resolveLineChannels();
}

describe("LINEチャネルの解決", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  it("シークレット未設定なら有効チャネルは0件（webhookは503を返す）", async () => {
    expect(await loadChannels({})).toHaveLength(0);
  });

  it("既存の LINE_CHANNEL_SECRET は秘書チャネルのフォールバックとして使われる", async () => {
    const channels = await loadChannels({
      LINE_CHANNEL_SECRET: "legacy-secret",
      LINE_CHANNEL_ACCESS_TOKEN: "legacy-token",
    });
    expect(channels).toHaveLength(1);
    expect(channels[0].key).toBe("secretary");
    expect(channels[0].secret).toBe("legacy-secret");
    expect(channels[0].accessToken).toBe("legacy-token");
  });

  it("LINE_SECRETARY_* があればそちらが優先される", async () => {
    const channels = await loadChannels({
      LINE_CHANNEL_SECRET: "legacy-secret",
      LINE_SECRETARY_CHANNEL_SECRET: "new-secret",
    });
    expect(channels[0].secret).toBe("new-secret");
  });

  it("秘書チャネルはGASへ転送する。GAS設定時は返信をGASに任せる", async () => {
    const withGas = await loadChannels({
      LINE_SECRETARY_CHANNEL_SECRET: "s",
      GAS_WEBHOOK_URL: "https://example.test/gas",
    });
    expect(withGas[0].forwardToGas).toBe(true);
    expect(withGas[0].replyBy).toBe("gas");

    const withoutGas = await loadChannels({ LINE_SECRETARY_CHANNEL_SECRET: "s" });
    expect(withoutGas[0].forwardToGas).toBe(true);
    expect(withoutGas[0].replyBy).toBe("alco_os");
  });

  it("捕獲者チャネルはGASへ転送せず、ALCO OSが返信する", async () => {
    const channels = await loadChannels({
      LINE_HUNTER_CHANNEL_SECRET: "h",
      GAS_WEBHOOK_URL: "https://example.test/gas",
    });
    expect(channels).toHaveLength(1);
    expect(channels[0].key).toBe("hunter");
    expect(channels[0].forwardToGas).toBe(false);
    expect(channels[0].replyBy).toBe("alco_os");
  });

  it("両方設定すれば2チャネルが有効になる", async () => {
    const channels = await loadChannels({
      LINE_SECRETARY_CHANNEL_SECRET: "s",
      LINE_HUNTER_CHANNEL_SECRET: "h",
      LINE_HUNTER_CHANNEL_ID: "Uhunter",
    });
    expect(channels.map((c) => c.key)).toEqual(["secretary", "hunter"]);
    expect(channels[1].channelId).toBe("Uhunter");
  });

  it("CHANNEL_ID を設定しなくてもチャネルは有効（Bot User IDは不要）", async () => {
    const channels = await loadChannels({ LINE_HUNTER_CHANNEL_SECRET: "h" });
    expect(channels).toHaveLength(1);
    expect(channels[0].channelId).toBe("");
    expect(channels[0].secret).toBe("h");
  });

  it("DB保存用の識別子は環境変数に依存しない安定ラベル", async () => {
    const without = await loadChannels({
      LINE_SECRETARY_CHANNEL_SECRET: "s",
      LINE_HUNTER_CHANNEL_SECRET: "h",
    });
    const withId = await loadChannels({
      LINE_SECRETARY_CHANNEL_SECRET: "s",
      LINE_HUNTER_CHANNEL_SECRET: "h",
      LINE_HUNTER_CHANNEL_ID: "Uhunter",
      LINE_SECRETARY_CHANNEL_ID: "Usecretary",
    });
    // あとから CHANNEL_ID を足しても ref は変わらない
    // = 既存の hunter_line_links が引けなくなることがない
    expect(without.map((c) => c.ref)).toEqual(["channel:secretary", "channel:hunter"]);
    expect(withId.map((c) => c.ref)).toEqual(without.map((c) => c.ref));
  });
});
