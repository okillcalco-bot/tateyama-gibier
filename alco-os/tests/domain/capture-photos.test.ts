import { describe, it, expect, beforeEach } from "vitest";
import {
  attachReportPhoto,
  missingCityFormPhotos,
  orderForCityForm,
  setPhotoKind,
  toReportPhoto,
} from "@/domain/hunters/capture-photo-service";
import { buildCityFormUrl, getCityFormReadiness } from "@/domain/hunters/city-form-service";
import { buildThread, sendHunterReply } from "@/domain/hunters/hunter-chat-service";
import { createPendingLink, blockLink } from "@/domain/hunters/hunter-link-service";
import { InMemoryDb } from "../helpers/in-memory-db";

const ORG = "org-1";
const CHANNEL = "channel:hunter";
const ctx = { organizationId: ORG, actorId: "staff-1" };

describe("捕獲報告の写真と種別（要望3）", () => {
  let db: InMemoryDb;
  let reportId: string;

  beforeEach(async () => {
    db = new InMemoryDb();
    const report = await db.insert("capture_reports", {
      organization_id: ORG,
      status: "pending",
    });
    reportId = report.id as string;
  });

  it("受信した写真は「未仕分け」で登録され、同じ写真は二重に入らない", async () => {
    await attachReportPhoto(db, { organizationId: ORG, captureReportId: reportId, fileId: "f1" });
    await attachReportPhoto(db, { organizationId: ORG, captureReportId: reportId, fileId: "f1" });

    const rows = db.tables.get("capture_report_photos") ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].photo_kind).toBe("unsorted");
  });

  it("職員が種別を決めると監査ログに残る", async () => {
    const photo = await attachReportPhoto(db, {
      organizationId: ORG,
      captureReportId: reportId,
      fileId: "f1",
    });
    const after = await setPhotoKind(db, ctx, {
      photoId: photo!.id as string,
      photoKind: "tail_before",
    });
    expect(after.photo_kind).toBe("tail_before");
    expect((db.tables.get("audit_logs") ?? []).length).toBe(1);
  });

  it("台紙は 全体 → 切る前 → 切った後 の順に並び、未仕分けは出さない", () => {
    const photos = [
      { id: "3", fileId: "f3", photoKind: "tail_after" as const, sortOrder: 2 },
      { id: "1", fileId: "f1", photoKind: "whole" as const, sortOrder: 0 },
      { id: "4", fileId: "f4", photoKind: "unsorted" as const, sortOrder: 3 },
      { id: "2", fileId: "f2", photoKind: "tail_before" as const, sortOrder: 1 },
    ];
    expect(orderForCityForm(photos).map((p) => p.photoKind)).toEqual([
      "whole",
      "tail_before",
      "tail_after",
    ]);
  });

  it("足りない写真の種別を教えてくれる", () => {
    expect(
      missingCityFormPhotos([{ id: "1", fileId: "f1", photoKind: "whole", sortOrder: 0 }]),
    ).toEqual(["tail_before", "tail_after"]);
  });

  it("提出パックの準備状況を返す", async () => {
    await db.update("capture_reports", reportId, {
      individual_id: "ind-1",
      capture_lat: 34.99,
      capture_lng: 139.87,
    });
    const p1 = await attachReportPhoto(db, {
      organizationId: ORG,
      captureReportId: reportId,
      fileId: "f1",
    });
    await setPhotoKind(db, ctx, { photoId: p1!.id as string, photoKind: "whole" });

    const readiness = await getCityFormReadiness(db, reportId);
    expect(readiness.hasIndividual).toBe(true);
    expect(readiness.hasLocation).toBe(true);
    expect(readiness.missingPhotos).toEqual(["tail_before", "tail_after"]);
    expect(readiness.photos).toHaveLength(1);
  });

  it("捕獲票は既存アプリのURLを組み立てるだけ（作り直さない）", () => {
    expect(buildCityFormUrl("https://gibier.example", "仮-ABC")).toBe(
      "https://gibier.example/capture-form.html?cityform=%E4%BB%AE-ABC",
    );
    expect(buildCityFormUrl("", "仮-ABC")).toBe("");
  });

  it("toReportPhoto は不正な種別を未仕分けに倒す", () => {
    expect(toReportPhoto({ id: "1", file_id: "f", photo_kind: "こわれた" }).photoKind).toBe(
      "unsorted",
    );
  });
});

describe("職員から捕獲者へのチャット返信（要望1）", () => {
  let db: InMemoryDb;
  let linkId: string;

  beforeEach(async () => {
    db = new InMemoryDb();
    const link = await createPendingLink(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineUserId: "U1",
    });
    linkId = link.id as string;
  });

  it("送信すると本文・送信者・時刻が残り、監査ログにも記録される", async () => {
    const sent: string[] = [];
    const outbound = await sendHunterReply(
      { db, ctx, send: async ({ text }) => (sent.push(text), { ok: true }) },
      { linkId, body: "明日の午前中に受け入れできます" },
    );

    expect(sent).toEqual(["明日の午前中に受け入れできます"]);
    expect(outbound.status).toBe("sent");
    expect(outbound.sent_by).toBe("staff-1");
    expect(outbound.sent_at).toBeTruthy();
    expect((db.tables.get("audit_logs") ?? []).length).toBe(1);
  });

  it("返信対象を指定すると、その受信メッセージが対応ずみになる", async () => {
    const message = await db.insert("line_inbound_messages", {
      organization_id: ORG,
      hunter_line_link_id: linkId,
      body: "搬入します",
      status: "new",
    });

    await sendHunterReply(
      { db, ctx, send: async () => ({ ok: true }) },
      { linkId, inReplyToId: message.id as string, body: "お待ちしています" },
    );

    const updated = await db.findById("line_inbound_messages", message.id as string);
    expect(updated?.status).toBe("handled");
    expect(updated?.replied_by).toBe("staff-1");
    expect(updated?.replied_at).toBeTruthy();
  });

  it("送信に失敗しても履歴に残し、エラーを返す", async () => {
    await expect(
      sendHunterReply(
        { db, ctx, send: async () => ({ ok: false, error: "LINE APIエラー（HTTP 429）" }) },
        { linkId, body: "テスト" },
      ),
    ).rejects.toThrow("HTTP 429");

    const rows = db.tables.get("line_outbound_messages") ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
  });

  it("受け取らない設定の相手には送れない", async () => {
    await blockLink(db, ctx, { linkId });
    await expect(
      sendHunterReply({ db, ctx, send: async () => ({ ok: true }) }, { linkId, body: "テスト" }),
    ).rejects.toThrow(/受け取らない/);
    expect(db.tables.get("line_outbound_messages") ?? []).toHaveLength(0);
  });

  it("空文字は送れない", async () => {
    await expect(
      sendHunterReply({ db, ctx, send: async () => ({ ok: true }) }, { linkId, body: "   " }),
    ).rejects.toThrow("返信の文章");
  });

  it("スレッドは受信と送信を時系列に並べる", () => {
    const thread = buildThread(
      [
        { id: "in-2", body: "2番目", received_at: "2026-07-26T10:05:00Z", message_type: "text" },
        { id: "in-1", body: "1番目", received_at: "2026-07-26T10:00:00Z", message_type: "text" },
      ],
      [{ id: "out-1", body: "返信", sent_at: "2026-07-26T10:10:00Z", sent_by: "staff-1" }],
    );
    expect(thread.map((e) => e.id)).toEqual(["in-1", "in-2", "out-1"]);
    expect(thread[2].direction).toBe("outbound");
    expect(thread[2].actorId).toBe("staff-1");
  });
});
