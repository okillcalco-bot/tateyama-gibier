import { describe, it, expect, beforeEach } from "vitest";
import {
  approveCaptureReport,
  buildTemporaryLabelId,
  openCaptureReport,
  rejectCaptureReport,
} from "@/domain/hunters/capture-report-service";
import { intakeHunterEvent } from "@/domain/hunters/hunter-message-service";
import { createPendingLink, verifyLink } from "@/domain/hunters/hunter-link-service";
import { getConversation } from "@/domain/hunters/conversation-state-service";
import { InMemoryDb } from "../helpers/in-memory-db";

/**
 * 捕獲報告の受け取りと、承認による個体化。
 * individuals へ書き込むのは承認したときだけであることを固定する。
 */

const ORG = "org-1";
const CHANNEL = "Udestination-hunter";
const USER = "Uhunter-line-user";
const ctx = { organizationId: ORG, actorId: "staff-1" };

async function verifiedLink(db: InMemoryDb, hunterName = "山田 太郎") {
  const hunter = await db.insert("hunters", { name: hunterName, city: "館山市" });
  const link = await createPendingLink(db, {
    organizationId: ORG,
    lineChannelId: CHANNEL,
    lineUserId: USER,
  });
  await verifyLink(db, ctx, { linkId: link.id as string, hunterId: hunter.id as string });
  return { hunterId: hunter.id as string, linkId: link.id as string, hunterName };
}

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    channelId: CHANNEL,
    channelKey: "hunter",
    webhookEventId: `evt-${Math.random().toString(36).slice(2)}`,
    eventType: "message",
    messageType: "text",
    lineUserId: USER,
    text: "捕獲報告",
    ...overrides,
  };
}

describe("捕獲報告の受け取り", () => {
  let db: InMemoryDb;

  beforeEach(async () => {
    db = new InMemoryDb();
    await verifiedLink(db);
  });

  it("「捕獲報告」で受け皿を作り、写真を送ってくださいと返す", async () => {
    const outcome = await intakeHunterEvent({ db, organizationId: ORG }, baseEvent());

    expect(outcome.kind).toBe("received");
    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.menuIntent).toBe("capture_report");
    expect(outcome.reply).toContain("写真");
    expect(outcome.captureReportId).toBeTruthy();

    const state = await getConversation(db, CHANNEL, USER);
    expect(state.state).toBe("awaiting_capture_photo");
    // この時点では individuals を作らない
    expect(db.tables.get("individuals")).toBeUndefined();
  });

  it("写真は Storage/files に保存され、報告に紐づく", async () => {
    await intakeHunterEvent({ db, organizationId: ORG }, baseEvent());

    const saved: string[] = [];
    const outcome = await intakeHunterEvent(
      {
        db,
        organizationId: ORG,
        savePhoto: async ({ lineMessageId, captureReportId }) => {
          saved.push(`${lineMessageId}:${captureReportId}`);
          const file = await db.insert("files", {
            organization_id: ORG,
            bucket: "alco-os",
            path: "hunter-line/2026/07/msg-1.jpg",
            filename: "msg-1.jpg",
            module: "hunter_line",
            related_table: "capture_reports",
            related_id: captureReportId,
          });
          return file.id as string;
        },
      },
      baseEvent({ messageType: "image", messageId: "msg-1", text: null }),
    );

    expect(saved).toHaveLength(1);
    if (outcome.kind !== "received") throw new Error("unreachable");
    const report = await db.findById("capture_reports", outcome.captureReportId!);
    expect(report?.photo_file_id).toBeTruthy();
    expect(outcome.reply).toContain("写真を受け取りました");
  });

  it("位置情報は座標を保存する（表示側でマスキングする）", async () => {
    await intakeHunterEvent({ db, organizationId: ORG }, baseEvent());

    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG },
      baseEvent({
        messageType: "location",
        text: null,
        hasLocation: true,
        latitude: 34.9967,
        longitude: 139.8701,
      }),
    );

    if (outcome.kind !== "received") throw new Error("unreachable");
    const report = await db.findById("capture_reports", outcome.captureReportId!);
    expect(report?.capture_lat).toBeCloseTo(34.9967);
    expect(report?.capture_lng).toBeCloseTo(139.8701);
    expect(outcome.reply).toContain("場所を受け取りました");
  });

  it("会話中の本文はAIの候補（ai_suggestion）として報告に足す", async () => {
    await intakeHunterEvent({ db, organizationId: ORG }, baseEvent());

    const outcome = await intakeHunterEvent(
      {
        db,
        organizationId: ORG,
        classify: async () => ({
          intent: "capture_report",
          suggestion: { species: "イノシシ", capture_method: "くくり罠" },
          draftId: "draft-1",
        }),
      },
      baseEvent({ text: "イノシシです。くくり罠でとれました" }),
    );

    if (outcome.kind !== "received") throw new Error("unreachable");
    const report = await db.findById("capture_reports", outcome.captureReportId!);
    expect(report?.raw_text).toContain("イノシシ");
    expect(report?.ai_suggestion).toEqual({ species: "イノシシ", capture_method: "くくり罠" });
    // 候補であって確定値ではない
    expect(report?.species).toBeUndefined();
    expect(report?.status).toBe("pending");
  });

  it("捕獲報告以外のメニューを押すと会話状態は閉じる", async () => {
    await intakeHunterEvent({ db, organizationId: ORG }, baseEvent());
    await intakeHunterEvent({ db, organizationId: ORG }, baseEvent({ text: "使い方" }));

    const state = await getConversation(db, CHANNEL, USER);
    expect(state.state).toBe("idle");
  });
});

describe("メニューの回答", () => {
  let db: InMemoryDb;

  beforeEach(async () => {
    db = new InMemoryDb();
    await verifiedLink(db);
  });

  it("受入状況は本日の受入件数を返す（仕様確定 2026-07-26）", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await db.insert("individuals", { capture_date: today, species: "イノシシ" });
    await db.insert("individuals", { capture_date: today, species: "シカ" });
    await db.insert("individuals", { capture_date: "2020-01-01", species: "イノシシ" });

    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG },
      baseEvent({ text: "受入状況" }),
    );
    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).toContain("本日の受入は 2 件です");
  });

  it("受入を止めている日はその旨も添える", async () => {
    await db.insert("org_settings", { key: "gibier_accepting", value: "受入停止" });
    await db.insert("org_settings", { key: "gibier_acceptance_note", value: "明日は受付します" });

    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG },
      baseEvent({ text: "受入状況" }),
    );
    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).toContain("受け入れを止めています");
    expect(outcome.reply).toContain("明日は受付します");
  });

  it("買取状況は準備中の案内を返し、金額を一切出さない（仕様確定 2026-07-26）", async () => {
    await db.insert("individuals", {
      hunter_name: "山田 太郎",
      capture_date: "2026-07-01",
      species: "イノシシ",
      buyback_amount: 8000,
    });

    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG },
      baseEvent({ text: "買取状況" }),
    );
    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).toContain("準備中");
    expect(outcome.reply).not.toMatch(/円/);
    // 問い合わせ自体は職員が見られるよう受信一覧に残る
    expect(db.tables.get("line_inbound_messages")).toHaveLength(1);
  });

  it("使い方は説明ページのリンクを添えて返す", async () => {
    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG, guideUrl: "https://example.test/guide" },
      baseEvent({ text: "使い方" }),
    );
    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).toContain("https://example.test/guide");
  });

  it("使い方はメニューの案内を返す", async () => {
    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG },
      baseEvent({ text: "使い方" }),
    );
    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).toContain("捕獲報告");
    expect(outcome.reply).toContain("電話");
  });

  it("捕獲報告の案内は尻尾の前後写真をお願いする（要望3）", async () => {
    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG },
      baseEvent({ text: "捕獲報告" }),
    );
    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).toContain("尻尾を切る前");
    expect(outcome.reply).toContain("尻尾を切った後");
  });

  it("どの受信にも必ず返事の文面がある（送りっぱなしにしない）", async () => {
    for (const text of ["捕獲報告", "搬入連絡", "受入状況", "買取状況", "使い方", "こんにちは"]) {
      const outcome = await intakeHunterEvent(
        { db, organizationId: ORG },
        baseEvent({ text }),
      );
      if (outcome.kind !== "received") throw new Error("unreachable");
      expect(outcome.reply.length).toBeGreaterThan(0);
    }
  });
});

describe("承認による個体化", () => {
  let db: InMemoryDb;
  let reportId: string;

  beforeEach(async () => {
    db = new InMemoryDb();
    const { linkId, hunterId } = await verifiedLink(db);
    const report = await openCaptureReport(db, {
      organizationId: ORG,
      hunterLineLinkId: linkId,
      hunterId,
      lineChannelId: CHANNEL,
      lineUserId: USER,
    });
    reportId = report.id as string;
    await db.update("capture_reports", reportId, { capture_lat: 34.99, capture_lng: 139.87 });
  });

  it("仮登録の管理番号は既存アプリと同じ「仮-」で始まる", () => {
    expect(buildTemporaryLabelId()).toMatch(/^仮-[0-9A-Z]+$/);
  });

  it("承認すると individuals に搬入待ちの仮登録ができる", async () => {
    const { individual, report } = await approveCaptureReport(db, ctx, {
      reportId,
      species: "イノシシ",
      captureMethod: "くくり罠",
      captureDate: "2026-07-25",
      hunterName: "山田 太郎",
    });

    expect(individual.intake_status).toBe("搬入待ち");
    expect(individual.serial_number).toBeNull();
    expect(String(individual.label_id)).toMatch(/^仮-/);
    expect(individual.hunter_name).toBe("山田 太郎");
    expect(individual.capture_lat).toBe(34.99);
    expect(report.status).toBe("accepted");
    expect(report.individual_id).toBe(individual.id);

    // 個体作成と承認の両方が監査ログに残る
    const logs = db.tables.get("audit_logs") ?? [];
    expect(logs.some((l) => l.table_name === "individuals" && l.action === "insert")).toBe(true);
    expect(logs.some((l) => l.table_name === "capture_reports" && l.action === "approve")).toBe(
      true,
    );
  });

  it("同じ報告を二度承認できない（個体の二重作成を防ぐ）", async () => {
    await approveCaptureReport(db, ctx, {
      reportId,
      species: "イノシシ",
      hunterName: "山田 太郎",
    });
    await expect(
      approveCaptureReport(db, ctx, { reportId, species: "イノシシ", hunterName: "山田 太郎" }),
    ).rejects.toThrow(/すでに/);
    expect(db.tables.get("individuals")).toHaveLength(1);
  });

  it("獣種と捕獲者名がないと承認できない", async () => {
    await expect(
      approveCaptureReport(db, ctx, { reportId, species: "", hunterName: "山田 太郎" }),
    ).rejects.toThrow("獣種を選んでください");
    await expect(
      approveCaptureReport(db, ctx, { reportId, species: "イノシシ", hunterName: "" }),
    ).rejects.toThrow(/捕獲者名/);
    expect(db.tables.get("individuals")).toBeUndefined();
  });

  it("取り消すと individuals は作られない", async () => {
    const rejected = await rejectCaptureReport(db, ctx, { reportId, reason: "重複" });
    expect(rejected.status).toBe("rejected");
    expect(db.tables.get("individuals")).toBeUndefined();
    expect((db.tables.get("audit_logs") ?? []).some((l) => l.action === "discard")).toBe(true);
  });
});
