import { describe, it, expect } from "vitest";
import {
  computeSignature,
  matchesDestination,
  readDestination,
  resolveChannelBySignature,
  verifySignature,
} from "@/lib/line/verify";
import type { LineChannel } from "@/lib/line/channels";

/**
 * 署名検証とチャネル特定。
 * destination は署名検証前には信用しないため、
 * 「シークレットで順に検証してチャネルを確定する」方式であることを固定する。
 */

const SECRETARY: LineChannel = {
  key: "secretary",
  label: "秘書チャネル",
  ref: "channel:secretary",
  channelId: "Udestination-secretary",
  secret: "test-secretary-secret",
  accessToken: "test-secretary-token",
  forwardToGas: true,
  replyBy: "gas",
};

const HUNTER: LineChannel = {
  key: "hunter",
  label: "捕獲者チャネル",
  ref: "channel:hunter",
  channelId: "Udestination-hunter",
  secret: "test-hunter-secret",
  accessToken: "test-hunter-token",
  forwardToGas: false,
  replyBy: "alco_os",
};

const CHANNELS = [SECRETARY, HUNTER];

function bodyFor(destination: string) {
  return JSON.stringify({ destination, events: [] });
}

describe("LINE署名検証", () => {
  it("正しい署名は検証を通る", () => {
    const body = bodyFor(HUNTER.channelId);
    expect(verifySignature(HUNTER.secret, body, computeSignature(HUNTER.secret, body))).toBe(true);
  });

  it("シークレットが違えば通らない", () => {
    const body = bodyFor(HUNTER.channelId);
    expect(verifySignature(HUNTER.secret, body, computeSignature("other-secret", body))).toBe(
      false,
    );
  });

  it("本文が1文字でも変われば通らない（生ボディで検証している）", () => {
    const body = bodyFor(HUNTER.channelId);
    const signature = computeSignature(HUNTER.secret, body);
    expect(verifySignature(HUNTER.secret, `${body} `, signature)).toBe(false);
  });

  it("シークレット未設定・署名なしは通らない", () => {
    const body = bodyFor(HUNTER.channelId);
    expect(verifySignature("", body, computeSignature(HUNTER.secret, body))).toBe(false);
    expect(verifySignature(HUNTER.secret, body, "")).toBe(false);
  });

  it("長さの違う署名でも例外にならず false", () => {
    const body = bodyFor(HUNTER.channelId);
    expect(verifySignature(HUNTER.secret, body, "短い")).toBe(false);
  });
});

describe("チャネルの特定", () => {
  it("秘書チャネルの署名なら秘書チャネルとして解決される", () => {
    const body = bodyFor(SECRETARY.channelId);
    const channel = resolveChannelBySignature(
      CHANNELS,
      body,
      computeSignature(SECRETARY.secret, body),
    );
    expect(channel?.key).toBe("secretary");
  });

  it("捕獲者チャネルの署名なら捕獲者チャネルとして解決される", () => {
    const body = bodyFor(HUNTER.channelId);
    const channel = resolveChannelBySignature(
      CHANNELS,
      body,
      computeSignature(HUNTER.secret, body),
    );
    expect(channel?.key).toBe("hunter");
  });

  it("destination を偽装しても、署名したシークレットのチャネルとして扱われる", () => {
    // 秘書のシークレットで署名し、destination だけ捕獲者を名乗るケース
    const body = bodyFor(HUNTER.channelId);
    const channel = resolveChannelBySignature(
      CHANNELS,
      body,
      computeSignature(SECRETARY.secret, body),
    );
    expect(channel?.key).toBe("secretary");
    // destination が合わないので、後段で処理を止められること
    expect(matchesDestination(channel!, readDestination(JSON.parse(body)))).toBe(false);
  });

  it("どのシークレットとも一致しなければ null（401にする）", () => {
    const body = bodyFor(HUNTER.channelId);
    expect(resolveChannelBySignature(CHANNELS, body, computeSignature("unknown", body))).toBeNull();
  });

  it("チャネルが1つも登録されていなければ null", () => {
    const body = bodyFor(HUNTER.channelId);
    expect(resolveChannelBySignature([], body, computeSignature(HUNTER.secret, body))).toBeNull();
  });
});

describe("destination の突き合わせ", () => {
  it("一致すれば true", () => {
    expect(matchesDestination(HUNTER, "Udestination-hunter")).toBe(true);
  });

  it("不一致なら false（設定ミスを検知する）", () => {
    expect(matchesDestination(HUNTER, "Udestination-secretary")).toBe(false);
  });

  it("channelId 未設定なら照合をスキップする", () => {
    expect(matchesDestination({ ...HUNTER, channelId: "" }, "なんでも")).toBe(true);
  });

  it("destination が無いボディでも止めない", () => {
    expect(readDestination(JSON.parse('{"events":[]}'))).toBeNull();
    expect(matchesDestination(HUNTER, null)).toBe(true);
  });
});
