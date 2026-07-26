import { describe, it, expect } from "vitest";
import { matchMenuKeyword, RICH_MENU_TEXTS } from "@/domain/hunters/hunter-keywords";

/**
 * リッチメニュー（2×3）のキーワード分岐。
 * LINE管理画面の設定と実装がずれないよう、5語をここで固定する。
 */
describe("リッチメニューのキーワード", () => {
  it("指示書の5語がそのまま定義されている", () => {
    expect(RICH_MENU_TEXTS).toEqual({
      capture_report: "捕獲報告",
      delivery_notice: "搬入連絡",
      acceptance_status: "受入状況",
      payment_status: "買取状況",
      help: "使い方",
    });
  });

  it("5語を正しく振り分ける", () => {
    expect(matchMenuKeyword("捕獲報告")).toBe("capture_report");
    expect(matchMenuKeyword("搬入連絡")).toBe("delivery_notice");
    expect(matchMenuKeyword("受入状況")).toBe("acceptance_status");
    expect(matchMenuKeyword("買取状況")).toBe("payment_status");
    expect(matchMenuKeyword("使い方")).toBe("help");
  });

  it("旧実装のキーワードも後方互換で受ける", () => {
    expect(matchMenuKeyword("搬入します")).toBe("delivery_notice");
    expect(matchMenuKeyword("現場引取を相談します")).toBe("delivery_notice");
    expect(matchMenuKeyword("受入方法")).toBe("help");
  });

  it("前後の空白・記号・全角空白があっても判定できる", () => {
    expect(matchMenuKeyword("  捕獲報告 ")).toBe("capture_report");
    expect(matchMenuKeyword("【受入状況】")).toBe("acceptance_status");
    expect(matchMenuKeyword("使い方！")).toBe("help");
    expect(matchMenuKeyword("捕　獲　報　告")).toBe("capture_report");
  });

  it("言い添えがあっても拾う", () => {
    expect(matchMenuKeyword("捕獲報告です")).toBe("capture_report");
    expect(matchMenuKeyword("搬入連絡お願いします")).toBe("delivery_notice");
  });

  it("メニュー以外の文はnull（AI分類にまわす）", () => {
    expect(matchMenuKeyword("おはようございます")).toBeNull();
    expect(matchMenuKeyword("きのう仕掛けた場所を見てきました")).toBeNull();
    expect(matchMenuKeyword("")).toBeNull();
  });
});
