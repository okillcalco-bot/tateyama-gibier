import { describe, it, expect, beforeEach } from "vitest";
import { classifyHunterMessage } from "@/ai/workflows/classify-hunter-message";
import { hunterMessageOutputSchema } from "@/ai/schemas/hunter-message.schema";
import { approveDraft } from "@/domain/drafts/draft-service";
import { MockProvider } from "@/ai/providers/mock-provider";
import { InMemoryDb } from "../helpers/in-memory-db";

/**
 * 捕獲者メッセージ分類のガードレールと、承認前に業務データが動かないこと。
 */

const ORG = "org-1";
const ctx = { organizationId: ORG, actorId: "staff-1" };

function workflowCtx(db: InMemoryDb, provider = new MockProvider()) {
  return { db, provider, organizationId: ORG, userId: "staff-1" };
}

describe("classify_hunter_message", () => {
  let db: InMemoryDb;

  beforeEach(() => {
    db = new InMemoryDb();
  });

  it("結果は generated_drafts に入り、承認するまでタスクを作らない", async () => {
    const message = await db.insert("line_inbound_messages", {
      organization_id: ORG,
      body: "イノシシ1頭これから搬入します",
      status: "new",
    });

    const result = await classifyHunterMessage(
      workflowCtx(db),
      { raw_text: "イノシシ1頭これから搬入します", has_location: false },
      { messageId: message.id as string },
    );

    const draft = await db.findById("generated_drafts", result.draftId);
    expect(draft?.draft_type).toBe("hunter_message_result");
    expect(draft?.status).toBe("draft");
    expect(draft?.source_table).toBe("line_inbound_messages");
    // 承認前: タスクは1件もない
    expect(db.tables.get("tasks") ?? []).toHaveLength(0);
    // ai_runs には記録される
    expect(db.tables.get("ai_runs")).toHaveLength(1);
  });

  it("ai_runs の要約に本文・氏名を入れない（docs/05）", async () => {
    await classifyHunterMessage(
      workflowCtx(db),
      {
        raw_text: "イノシシ1頭これから搬入します",
        hunter_name: "山田 太郎",
        has_location: false,
      },
      {},
    );
    const run = (db.tables.get("ai_runs") ?? [])[0];
    const summary = String(run.input_summary);
    expect(summary).not.toContain("山田");
    expect(summary).not.toContain("イノシシ1頭これから搬入します");
  });

  it("承認するとタスクが作られ、受信メッセージが対応ずみになる", async () => {
    const message = await db.insert("line_inbound_messages", {
      organization_id: ORG,
      body: "イノシシ1頭これから搬入します",
      status: "classified",
    });
    const result = await classifyHunterMessage(
      workflowCtx(db),
      { raw_text: "イノシシ1頭これから搬入します", has_location: false },
      { messageId: message.id as string },
    );

    const approved = await approveDraft(db, ctx, result.draftId);

    expect(approved.draft.status).toBe("approved");
    expect(approved.createdRecords.length).toBeGreaterThan(0);
    const updated = await db.findById("line_inbound_messages", message.id as string);
    expect(updated?.status).toBe("handled");
    // 既存ジビエ基幹テーブルには何も書いていない
    expect(db.tables.get("individuals")).toBeUndefined();
    expect(db.tables.get("hunters")).toBeUndefined();
  });

  it("わな・捕獲場所の語があれば、AIの判定に関わらず sensitivity_flag を立てる", async () => {
    const provider = new MockProvider({
      classify_hunter_message: JSON.stringify({
        summary: "くくりわなの場所まで来てほしいという相談。",
        detected_intent: "pickup_consult",
        extracted: {
          species: "イノシシ",
          head_count: 1,
          desired_datetime_text: null,
          place_text: "山の上のくくりわな",
          phone_text: null,
        },
        suggested_reply: "担当者が確認のうえご連絡します。",
        suggested_tasks: [],
        missing_fields: [],
        sensitivity_flag: false, // AIが安全側に倒し損ねたケース
        sensitivity_reason: "",
        confidence: 0.7,
        needs_human_review: true,
        warnings: [],
      }),
    });

    const result = await classifyHunterMessage(
      workflowCtx(db, provider),
      { raw_text: "くくりわなに1頭かかったので現場まで来てほしい", has_location: false },
      {},
    );

    expect(result.output.sensitivity_flag).toBe(true);
    expect(result.output.sensitivity_reason).not.toBe("");
  });

  it("位置情報が添付されていれば sensitivity_flag を立てる", async () => {
    const result = await classifyHunterMessage(
      workflowCtx(db),
      { raw_text: "ここです", has_location: true },
      {},
    );
    expect(result.output.sensitivity_flag).toBe(true);
  });
});

describe("hunter_message の出力スキーマ", () => {
  it("決められた種類以外は受け付けない", () => {
    expect(() =>
      hunterMessageOutputSchema.parse({
        summary: "テスト",
        detected_intent: "weather_chat",
        confidence: 0.5,
      }),
    ).toThrow();
  });

  it("リッチメニューの5種類は受け付ける", () => {
    for (const intent of [
      "capture_report",
      "delivery_notice",
      "acceptance_status",
      "payment_status",
      "help",
    ]) {
      const parsed = hunterMessageOutputSchema.parse({
        summary: "テスト",
        detected_intent: intent,
        confidence: 0.5,
      });
      expect(parsed.detected_intent).toBe(intent);
    }
  });

  it("旧実装の種類も後方互換で読める（保存済みドラフトの表示用）", () => {
    const parsed = hunterMessageOutputSchema.parse({
      summary: "テスト",
      detected_intent: "pickup_consult",
      confidence: 0.5,
    });
    expect(parsed.detected_intent).toBe("pickup_consult");
  });

  it("読み取れない項目は null のまま通る（推測で埋めない）", () => {
    const parsed = hunterMessageOutputSchema.parse({
      summary: "受入時間の問い合わせ。",
      detected_intent: "acceptance_info",
      confidence: 0.6,
    });
    expect(parsed.extracted.species).toBeNull();
    expect(parsed.extracted.head_count).toBeNull();
    expect(parsed.needs_human_review).toBe(true);
  });
});
