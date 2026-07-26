import { describe, it, expect } from "vitest";
import { buildHunterAutoReply } from "@/lib/line/hunter-intake";
import { ACK_TEXT, askNameReply, helpReply } from "@/domain/hunters/hunter-replies";

/**
 * 捕獲者への返信は必ず定型文。
 * AIが書いた文面を自動送信しないこと、送りっぱなしにしないことを固定する。
 */
describe("捕獲者への即時返信", () => {
  it("確認まちの相手にもドメインが決めた定型文をそのまま返す", () => {
    expect(
      buildHunterAutoReply({
        kind: "pending",
        linkId: "l1",
        messageId: "m1",
        isNew: true,
        reply: askNameReply(),
      }),
    ).toContain("お名前");
  });

  it("受信したメッセージには必ず返事の文面がある", () => {
    const text = buildHunterAutoReply({
      kind: "received",
      linkId: "l1",
      messageId: "m1",
      classified: true,
      menuIntent: null,
      captureReportId: null,
      reply: ACK_TEXT,
    });
    expect(text).toBe(ACK_TEXT);
  });

  it("メニューの回答文もそのまま返す", () => {
    const text = buildHunterAutoReply({
      kind: "received",
      linkId: "l1",
      messageId: "m1",
      classified: false,
      menuIntent: "help",
      captureReportId: null,
      reply: helpReply(),
    });
    expect(text).toContain("使い方");
  });

  it("再送・対象外・受け取らない設定には返信しない（replyToken を消費しない）", () => {
    expect(buildHunterAutoReply({ kind: "duplicate" })).toBeNull();
    expect(buildHunterAutoReply({ kind: "skipped", reason: "follow" })).toBeNull();
    expect(buildHunterAutoReply({ kind: "blocked", linkId: "l1" })).toBeNull();
  });

  it("定型文は受入や時間を約束しない", () => {
    expect(ACK_TEXT).not.toMatch(/受け入れます|お伺いします|引き取ります/);
  });
});
