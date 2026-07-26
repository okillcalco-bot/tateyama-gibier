import { describe, it, expect, beforeEach } from "vitest";
import { intakeHunterEvent } from "@/domain/hunters/hunter-message-service";
import { createPendingLink, verifyLink } from "@/domain/hunters/hunter-link-service";
import { getConversation, setConversation } from "@/domain/hunters/conversation-state-service";
import { InMemoryDb } from "../helpers/in-memory-db";

/**
 * 定型文フロー（フェーズ3）。
 * 1回で送れること・不足だけを聞くこと・そろったらリンクを出すことを固定する。
 */

const ORG = "org-1";
const CHANNEL = "channel:hunter";
const USER = "Uhunter";
const SITE = "https://alco-os.test";
const ctx = { organizationId: ORG, actorId: "staff-1" };

async function setup() {
  const db = new InMemoryDb();
  const hunter = await db.insert("hunters", { name: "山田 太郎" });
  const link = await createPendingLink(db, {
    organizationId: ORG,
    lineChannelId: CHANNEL,
    lineUserId: USER,
  });
  await verifyLink(db, ctx, { linkId: link.id as string, hunterId: hunter.id as string });
  return db;
}

function event(overrides: Record<string, unknown> = {}) {
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

const FULL_FORM = [
  "獣種：イノシシ",
  "捕獲方法：くくり罠",
  "場所：館山市山本",
  "捕獲日：2026-07-25",
  "体重：45",
  "体重の測り方：センターで計量",
  "性別：オス",
  "止め刺し：銃",
].join("\n");

describe("定型文で1回入力", () => {
  let db: InMemoryDb;

  beforeEach(async () => {
    db = await setup();
  });

  it("開始メッセージに型と「型は任意」の案内が入る", async () => {
    const outcome = await intakeHunterEvent({ db, organizationId: ORG, siteUrl: SITE }, event());
    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).toContain("獣種：");
    expect(outcome.reply).toContain("捕獲日：");
    expect(outcome.reply).toContain("1つずつ聞くこともできます");
    // 写真は2枚
    expect(outcome.reply).toContain("尻尾を切る前");
    expect(outcome.reply).not.toContain("全体がわかる写真");
  });

  it("型がそろえば1往復で捕獲票のリンクを返す", async () => {
    await intakeHunterEvent({ db, organizationId: ORG, siteUrl: SITE }, event());
    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG, siteUrl: SITE },
      event({ text: FULL_FORM }),
    );

    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).toContain(`${SITE}/hunter/city-form/`);
    expect(outcome.reply).toContain("30日間有効");

    const report = (db.tables.get("capture_reports") ?? [])[0];
    expect(report.species).toBe("イノシシ");
    expect(report.capture_place).toBe("館山市山本");
    expect(report.weight_measure).toBe("center");
    expect(String(report.share_token).length).toBe(32);
    // 会話は閉じる
    expect((await getConversation(db, CHANNEL, USER)).state).toBe("idle");
  });

  it("不足があれば足りない項目だけを1通でまとめて聞く", async () => {
    await intakeHunterEvent({ db, organizationId: ORG, siteUrl: SITE }, event());
    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG, siteUrl: SITE },
      event({ text: "獣種：イノシシ\n捕獲方法：くくり罠" }),
    );

    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).toContain("あと少しだけ教えてください");
    expect(outcome.reply).toContain("性別");
    expect(outcome.reply).toContain("体重");
    // リンクはまだ出さない
    expect(outcome.reply).not.toContain("/hunter/city-form/");
    expect((await getConversation(db, CHANNEL, USER)).state).toBe("awaiting_capture_form");
    // ワンタップ候補が付く
    expect(outcome.choices?.length ?? 0).toBeGreaterThan(0);
  });

  it("追加の1通で不足が埋まればリンクを出す（前の入力は消えない）", async () => {
    await intakeHunterEvent({ db, organizationId: ORG, siteUrl: SITE }, event());
    await intakeHunterEvent(
      { db, organizationId: ORG, siteUrl: SITE },
      event({ text: "獣種：イノシシ\n捕獲方法：くくり罠\n場所：山本" }),
    );
    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG, siteUrl: SITE },
      event({
        text: "性別：オス\n体重：45\n体重の測り方：推定\n止め刺し：銃",
      }),
    );

    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).toContain("/hunter/city-form/");
    const report = (db.tables.get("capture_reports") ?? [])[0];
    expect(report.species).toBe("イノシシ");
    expect(report.capture_place).toBe("山本");
    expect(report.weight_measure).toBe("estimated");
  });

  it("捕獲日が空欄なら送信日を使う", async () => {
    await intakeHunterEvent({ db, organizationId: ORG, siteUrl: SITE }, event());
    const now = new Date("2026-07-26T10:00:00+09:00");
    await intakeHunterEvent(
      { db, organizationId: ORG, siteUrl: SITE, now: () => now },
      event({
        text: [
          "獣種：イノシシ",
          "捕獲方法：くくり罠",
          "場所：山本",
          "捕獲日：",
          "性別：オス",
          "体重：45",
          "体重の測り方：推定",
          "止め刺し：銃",
        ].join("\n"),
      }),
    );
    const report = (db.tables.get("capture_reports") ?? [])[0];
    expect(report.capture_date).toBe(now.toISOString().slice(0, 10));
  });

  it("箱罠は わな番号 も聞く", async () => {
    await intakeHunterEvent({ db, organizationId: ORG, siteUrl: SITE }, event());
    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG, siteUrl: SITE },
      event({
        text: [
          "獣種：イノシシ",
          "捕獲方法：箱罠",
          "場所：山本",
          "性別：オス",
          "体重：45",
          "体重の測り方：推定",
          "止め刺し：銃",
        ].join("\n"),
      }),
    );
    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).toContain("箱わなの番号");
  });

  it("型を使わない人は従来どおり1つずつ聞く（体重サブフローへ）", async () => {
    await intakeHunterEvent({ db, organizationId: ORG, siteUrl: SITE }, event());
    const outcome = await intakeHunterEvent(
      {
        db,
        organizationId: ORG,
        siteUrl: SITE,
        classify: async () => ({ intent: "capture_report", suggestion: null, draftId: null }),
      },
      event({ text: "きのう山の上でとれました" }),
    );
    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).toContain("体重");
    expect((await getConversation(db, CHANNEL, USER)).state).toBe("awaiting_weight_kind");
  });

  it("公開URLが未設定なら壊れたリンクを送らない", async () => {
    await intakeHunterEvent({ db, organizationId: ORG }, event());
    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG },
      event({ text: FULL_FORM }),
    );
    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).not.toContain("http");
  });
});

/**
 * 本番テスト（2026-07-27）で見つかった不具合の再現テスト。
 * 沖代表のスクリーンショットに沿ってタイムラインを再現する。
 */
describe("本番で見つかった不具合の再現", () => {
  let db: InMemoryDb;

  /** 写真を1枚受け取る（種別は unsorted のまま = 職員が後で仕分ける） */
  async function sendPhoto(messageId: string) {
    return intakeHunterEvent(
      {
        db,
        organizationId: ORG,
        siteUrl: SITE,
        savePhoto: async ({ captureReportId }) => {
          const file = await db.insert("files", {
            organization_id: ORG,
            bucket: "alco-os",
            path: `hunter-line/${messageId}.jpg`,
            filename: `${messageId}.jpg`,
            related_table: "capture_reports",
            related_id: captureReportId,
          });
          return file.id as string;
        },
      },
      event({ messageType: "image", messageId, text: null }),
    );
  }

  beforeEach(async () => {
    db = await setup();
  });

  it("バグA: 写真2枚（unsorted）で「まだ足りない」と催促しない", async () => {
    await intakeHunterEvent({ db, organizationId: ORG, siteUrl: SITE }, event());

    const first = await sendPhoto("msg-1");
    if (first.kind !== "received") throw new Error("unreachable");
    expect(first.reply).toContain("写真1枚を受け取りました");

    const second = await sendPhoto("msg-2");
    if (second.kind !== "received") throw new Error("unreachable");
    expect(second.reply).toContain("写真2枚を受け取りました");
    expect(second.reply).toContain("ありがとうございます");
    // 種別は職員の作業。捕獲者に催促しない
    expect(second.reply).not.toContain("お願いします");

    // 保存された写真はすべて未仕分け（種別ベースだと「不足」に見える状態）
    const photos = db.tables.get("capture_report_photos") ?? [];
    expect(photos).toHaveLength(2);
    expect(photos.every((p) => p.photo_kind === "unsorted")).toBe(true);
  });

  it("バグA: 2枚あればリンク送信時に「写真がまだ」と言わない", async () => {
    await intakeHunterEvent({ db, organizationId: ORG, siteUrl: SITE }, event());
    await sendPhoto("msg-1");
    await sendPhoto("msg-2");

    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG, siteUrl: SITE },
      event({ text: FULL_FORM }),
    );
    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).toContain("/hunter/city-form/");
    expect(outcome.reply).not.toContain("写真がまだ");
    expect(outcome.reply).not.toContain("尻尾を切る前");
  });

  it("バグA: 1枚しかなければ枚数で伝える（種別名では催促しない）", async () => {
    await intakeHunterEvent({ db, organizationId: ORG, siteUrl: SITE }, event());
    await sendPhoto("msg-1");

    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG, siteUrl: SITE },
      event({ text: FULL_FORM }),
    );
    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).toContain("写真は1枚届いています");
  });

  it("バグB: そろった後の自由文で体重サブフローが再起動しない", async () => {
    await intakeHunterEvent({ db, organizationId: ORG, siteUrl: SITE }, event());
    await sendPhoto("msg-1");
    await sendPhoto("msg-2");
    await intakeHunterEvent(
      { db, organizationId: ORG, siteUrl: SITE },
      event({ text: FULL_FORM }),
    );

    // 位置情報 → 新しい空の報告を作ってしまわないこと
    await intakeHunterEvent(
      { db, organizationId: ORG, siteUrl: SITE },
      event({ messageType: "location", text: null, hasLocation: true, latitude: 34.9, longitude: 139.8 }),
    );
    expect(db.tables.get("capture_reports")).toHaveLength(1);

    // 自由文
    const outcome = await intakeHunterEvent(
      {
        db,
        organizationId: ORG,
        siteUrl: SITE,
        classify: async () => ({ intent: "other", suggestion: null, draftId: null }),
      },
      event({ text: "写真は送ってるよ" }),
    );

    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).not.toContain("体重について教えてください");
    expect(outcome.reply).toContain("すでに受け付けています");
    expect(outcome.choices ?? []).toHaveLength(0);
    expect((await getConversation(db, CHANNEL, USER)).state).toBe("idle");
  });

  it("バグB: 体重の3択を押し直しても数値を聞き直さない", async () => {
    await intakeHunterEvent({ db, organizationId: ORG, siteUrl: SITE }, event());
    await intakeHunterEvent(
      { db, organizationId: ORG, siteUrl: SITE },
      event({ text: FULL_FORM }),
    );

    // 体重の質問に戻ってしまう状況を作る（会話状態だけ体重待ちにする）
    const report = (db.tables.get("capture_reports") ?? [])[0];
    await setConversation(db, {
      organizationId: ORG,
      lineChannelId: CHANNEL,
      lineUserId: USER,
      state: "awaiting_weight_kind",
      captureReportId: report.id as string,
    });

    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG, siteUrl: SITE },
      event({ text: "処理施設で計量" }),
    );
    if (outcome.kind !== "received") throw new Error("unreachable");
    expect(outcome.reply).toContain("記録済み");
    expect(outcome.reply).not.toContain("数字で送ってください");
    expect((await getConversation(db, CHANNEL, USER)).state).toBe("idle");
  });

  it("そろった報告に文章が来ても、既に渡したリンクを作り直さない", async () => {
    await intakeHunterEvent({ db, organizationId: ORG, siteUrl: SITE }, event());
    const first = await intakeHunterEvent(
      { db, organizationId: ORG, siteUrl: SITE },
      event({ text: FULL_FORM }),
    );
    if (first.kind !== "received") throw new Error("unreachable");
    const token = (db.tables.get("capture_reports") ?? [])[0].share_token;

    await intakeHunterEvent(
      { db, organizationId: ORG, siteUrl: SITE },
      event({ text: FULL_FORM }),
    );
    expect((db.tables.get("capture_reports") ?? [])[0].share_token).toBe(token);
  });
});

describe("グループからのメッセージは業務処理しない（0028）", () => {
  let db: InMemoryDb;

  beforeEach(async () => {
    db = await setup();
  });

  it("グループ発言で捕獲者の紐付けや報告を作らない", async () => {
    // webhook 側でグループを分岐するため、ドメインには userId 無しで届く想定
    const outcome = await intakeHunterEvent(
      { db, organizationId: ORG, siteUrl: SITE },
      event({ lineUserId: null, text: "おつかれさまです" }),
    );
    expect(outcome.kind).toBe("skipped");
    expect(db.tables.get("capture_reports")).toBeUndefined();
    expect((db.tables.get("line_inbound_messages") ?? []).length).toBe(0);
  });
});
