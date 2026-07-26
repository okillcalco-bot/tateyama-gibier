import type { DbPort, Row } from "@/lib/db/port";
import { createPendingLink, findLinkByLineUser } from "./hunter-link-service";
import { matchMenuKeyword, type HunterMenuIntent } from "./hunter-keywords";
import {
  attachDetail,
  attachLocation,
  attachPhoto,
  openCaptureReport,
} from "./capture-report-service";
import {
  clearConversation,
  getConversation,
  setConversation,
} from "./conversation-state-service";
import { getAcceptanceStatus, getRecentBuybacks } from "./gibier-status-service";
import {
  ACK_TEXT,
  acceptanceStatusReply,
  askNameReply,
  captureReportDetailSavedReply,
  captureReportLocationSavedReply,
  captureReportPhotoSavedReply,
  captureReportStartReply,
  deliveryNoticeReply,
  freeTextReply,
  helpReply,
  paymentStatusReply,
} from "./hunter-replies";

/**
 * 捕獲者チャネルの受信処理（ドメイン層）。
 *
 * 流れ:
 *   重複確認 → イベント保存 → LINEユーザー照合 → メッセージ保存
 *   → リッチメニューのキーワード分岐（AIより先）
 *   → 捕獲報告の会話中なら写真・位置・本文を報告へ足す
 *   → それ以外の自由文はAI分類（候補のみ・generated_drafts）
 *   → **必ず即時返信の文面を返す**（送りっぱなしにしない）
 *
 * 絶対ルール:
 * - individuals / hunters / orders へは書き込まない
 *   （individuals の作成は職員が承認したときの capture-report-service だけ）
 * - AIの出力は generated_drafts と ai_suggestion に入るだけ
 * - DbPort にのみ依存する（Supabase 直接依存なし＝テスト可能）
 */

export interface HunterEventInput {
  channelId: string;
  channelKey: string;
  webhookEventId: string;
  eventType: string;
  messageType?: string | null;
  messageId?: string | null;
  lineUserId?: string | null;
  text?: string | null;
  hasLocation?: boolean;
  /** 位置情報メッセージの座標（原座標。表示時は必ずマスキングする） */
  latitude?: number | null;
  longitude?: number | null;
}

export type HunterIntakeOutcome =
  | { kind: "duplicate" }
  | { kind: "skipped"; reason: string }
  | { kind: "blocked"; linkId: string }
  | {
      kind: "pending";
      linkId: string;
      messageId: string | null;
      isNew: boolean;
      reply: string;
    }
  | {
      kind: "received";
      linkId: string;
      messageId: string;
      classified: boolean;
      menuIntent: HunterMenuIntent | null;
      captureReportId: string | null;
      reply: string;
    };

export interface HunterClassifyResult {
  intent: string | null;
  /** AIの読み取り候補。確定値ではない */
  suggestion?: Record<string, unknown> | null;
  draftId?: string | null;
}

export interface HunterIntakeDeps {
  db: DbPort;
  organizationId: string;
  /** AI分類。未指定なら分類せず保存だけ行う（AI未設定でも受信は壊さない） */
  classify?: (params: {
    messageId: string;
    text: string;
    hunterName?: string;
    hasLocation: boolean;
  }) => Promise<HunterClassifyResult>;
  /** 写真の保存（Content API取得 → Storage → files）。fileId を返す */
  savePhoto?: (params: {
    lineMessageId: string;
    captureReportId: string;
  }) => Promise<string | null>;
  /** LINEプロフィールの表示名取得 */
  fetchDisplayName?: (lineUserId: string) => Promise<string | null>;
  now?: () => Date;
}

async function isDuplicate(db: DbPort, webhookEventId: string): Promise<boolean> {
  if (!webhookEventId) return false;
  const rows = await db.findMany("line_webhook_events", { webhook_event_id: webhookEventId }, 1);
  return rows.length > 0;
}

async function finishEvent(
  db: DbPort,
  event: Row | null,
  status: "processed" | "skipped" | "failed",
  error?: string,
): Promise<void> {
  if (!event?.id) return;
  await db.update("line_webhook_events", event.id as string, {
    process_status: status,
    processed_at: new Date().toISOString(),
    error: error ?? null,
  });
}

/** 照合済み捕獲者の氏名を読む（読み取り専用。失敗しても処理を止めない） */
async function readHunterName(db: DbPort, hunterId: unknown): Promise<string | undefined> {
  if (typeof hunterId !== "string" || !hunterId) return undefined;
  try {
    const hunter = await db.findById("hunters", hunterId);
    const name = hunter?.name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/** 進行中の捕獲報告を取り出す。無ければ新しく開く */
async function ensureCaptureReport(
  deps: HunterIntakeDeps,
  params: {
    link: Row;
    channelId: string;
    lineUserId: string;
    existingId: string | null;
  },
): Promise<Row> {
  if (params.existingId) {
    const existing = await deps.db.findById("capture_reports", params.existingId);
    if (existing && existing.status === "pending") return existing;
  }
  return openCaptureReport(deps.db, {
    organizationId: deps.organizationId,
    hunterLineLinkId: params.link.id as string,
    hunterId: typeof params.link.hunter_id === "string" ? params.link.hunter_id : null,
    lineChannelId: params.channelId,
    lineUserId: params.lineUserId,
  });
}

export async function intakeHunterEvent(
  deps: HunterIntakeDeps,
  input: HunterEventInput,
): Promise<HunterIntakeOutcome> {
  const { db, organizationId } = deps;
  const now = deps.now ? deps.now() : new Date();

  if (await isDuplicate(db, input.webhookEventId)) {
    return { kind: "duplicate" };
  }

  const event = await db.insert("line_webhook_events", {
    organization_id: organizationId,
    webhook_event_id: input.webhookEventId,
    line_channel_id: input.channelId,
    channel_key: input.channelKey,
    event_type: input.eventType,
    message_type: input.messageType ?? null,
    line_user_id: input.lineUserId ?? null,
    process_status: "received",
  });

  if (!input.lineUserId) {
    await finishEvent(db, event, "skipped", "送信者IDがありません");
    return { kind: "skipped", reason: "送信者IDがありません" };
  }
  if (input.eventType !== "message") {
    await finishEvent(db, event, "skipped", `対象外のイベント: ${input.eventType}`);
    return { kind: "skipped", reason: `対象外のイベント: ${input.eventType}` };
  }

  // ── 送信者の照合 ──
  let link = await findLinkByLineUser(db, input.channelId, input.lineUserId);
  let isNewLink = false;
  if (!link) {
    const displayName = deps.fetchDisplayName
      ? await deps.fetchDisplayName(input.lineUserId)
      : null;
    link = await createPendingLink(db, {
      organizationId,
      lineChannelId: input.channelId,
      lineUserId: input.lineUserId,
      lineDisplayName: displayName,
    });
    isNewLink = true;
  }

  if (link.status === "blocked") {
    await finishEvent(db, event, "skipped", "受け取らない設定の相手");
    return { kind: "blocked", linkId: link.id as string };
  }

  // ── メッセージの保存 ──
  const hasLocation = input.hasLocation === true || input.messageType === "location";
  const text = (input.text ?? "").trim();
  const menuIntent = text ? matchMenuKeyword(text) : null;

  const message = await db.insert("line_inbound_messages", {
    organization_id: organizationId,
    hunter_line_link_id: link.id,
    line_channel_id: input.channelId,
    line_user_id: input.lineUserId,
    webhook_event_id: input.webhookEventId,
    message_type: input.messageType ?? "text",
    body: text || null,
    has_location: hasLocation,
    detected_intent: menuIntent,
    status: menuIntent ? "classified" : "new",
  });

  // ── 確認まち（誰か分からない相手）: AIも捕獲報告も動かさない ──
  if (link.status !== "verified") {
    await finishEvent(db, event, "processed");
    return {
      kind: "pending",
      linkId: link.id as string,
      messageId: message.id as string,
      isNew: isNewLink,
      reply: isNewLink ? askNameReply() : ACK_TEXT,
    };
  }

  const hunterName = await readHunterName(db, link.hunter_id);
  const conversation = await getConversation(db, input.channelId, input.lineUserId, now);

  let reply = ACK_TEXT;
  let classified = false;
  let captureReportId: string | null = conversation.captureReportId;

  try {
    if (menuIntent) {
      // ── 1. リッチメニューのキーワード（AIより先に確実に振り分ける） ──
      switch (menuIntent) {
        case "capture_report": {
          const report = await ensureCaptureReport(deps, {
            link,
            channelId: input.channelId,
            lineUserId: input.lineUserId,
            existingId: null,
          });
          captureReportId = report.id as string;
          await setConversation(db, {
            organizationId,
            lineChannelId: input.channelId,
            lineUserId: input.lineUserId,
            state: "awaiting_capture_photo",
            captureReportId,
            now,
          });
          reply = captureReportStartReply();
          break;
        }
        case "delivery_notice": {
          reply = deliveryNoticeReply(await getAcceptanceStatus(db));
          break;
        }
        case "acceptance_status": {
          reply = acceptanceStatusReply(await getAcceptanceStatus(db));
          break;
        }
        case "payment_status": {
          if (!hunterName) {
            reply = paymentStatusReply({ linked: false, rows: [] });
          } else {
            reply = paymentStatusReply({
              linked: true,
              hunterName,
              rows: await getRecentBuybacks(db, hunterName),
            });
          }
          break;
        }
        case "help": {
          reply = helpReply();
          break;
        }
      }
    } else if (input.messageType === "image") {
      // ── 2. 写真 ──
      const report = await ensureCaptureReport(deps, {
        link,
        channelId: input.channelId,
        lineUserId: input.lineUserId,
        existingId: conversation.captureReportId,
      });
      captureReportId = report.id as string;

      let fileId: string | null = null;
      if (deps.savePhoto && input.messageId) {
        fileId = await deps.savePhoto({
          lineMessageId: input.messageId,
          captureReportId,
        });
      }
      if (fileId) await attachPhoto(db, captureReportId, fileId);

      await setConversation(db, {
        organizationId,
        lineChannelId: input.channelId,
        lineUserId: input.lineUserId,
        state: "awaiting_capture_detail",
        captureReportId,
        now,
      });
      reply = captureReportPhotoSavedReply();
    } else if (hasLocation) {
      // ── 3. 位置情報（原座標を保存。表示時は必ず geo-masking を通す） ──
      const report = await ensureCaptureReport(deps, {
        link,
        channelId: input.channelId,
        lineUserId: input.lineUserId,
        existingId: conversation.captureReportId,
      });
      captureReportId = report.id as string;

      if (typeof input.latitude === "number" && typeof input.longitude === "number") {
        await attachLocation(db, captureReportId, input.latitude, input.longitude);
      }
      await setConversation(db, {
        organizationId,
        lineChannelId: input.channelId,
        lineUserId: input.lineUserId,
        state: "awaiting_capture_detail",
        captureReportId,
        now,
      });
      reply = captureReportLocationSavedReply();
    } else if (text && conversation.state !== "idle") {
      // ── 4. 捕獲報告の会話中の本文（AIは候補のみ） ──
      const report = await ensureCaptureReport(deps, {
        link,
        channelId: input.channelId,
        lineUserId: input.lineUserId,
        existingId: conversation.captureReportId,
      });
      captureReportId = report.id as string;

      let suggestion: Record<string, unknown> | null = null;
      let draftId: string | null = null;
      if (deps.classify) {
        try {
          const result = await deps.classify({
            messageId: message.id as string,
            text,
            hunterName,
            hasLocation,
          });
          suggestion = result.suggestion ?? null;
          draftId = result.draftId ?? null;
          classified = true;
        } catch {
          // ai_runs に失敗が記録済み。職員が画面で読める
        }
      }
      await attachDetail(db, captureReportId, {
        rawText: text,
        aiSuggestion: suggestion,
        sourceDraftId: draftId,
      });
      reply = captureReportDetailSavedReply();
    } else if (text) {
      // ── 5. 自由文（メニュー以外）: AI分類のみ。業務データは動かさない ──
      if (deps.classify) {
        try {
          const result = await deps.classify({
            messageId: message.id as string,
            text,
            hunterName,
            hasLocation,
          });
          await db.update("line_inbound_messages", message.id as string, {
            detected_intent: result.intent,
            status: "classified",
          });
          classified = true;
        } catch {
          // ai_runs に失敗が記録済み
        }
      }
      reply = freeTextReply();
    } else {
      // ── 6. スタンプ・音声など ──
      reply = ACK_TEXT;
    }
  } catch (error) {
    await finishEvent(
      db,
      event,
      "failed",
      error instanceof Error ? error.message : "処理に失敗しました",
    );
    // 捕獲者を無言にしない
    return {
      kind: "received",
      linkId: link.id as string,
      messageId: message.id as string,
      classified: false,
      menuIntent,
      captureReportId,
      reply: ACK_TEXT,
    };
  }

  // 捕獲報告以外の操作をしたら会話状態を閉じる（次の写真を誤って報告に足さない）
  if (menuIntent && menuIntent !== "capture_report") {
    await clearConversation(db, {
      organizationId,
      lineChannelId: input.channelId,
      lineUserId: input.lineUserId,
    });
    captureReportId = null;
  }

  await finishEvent(db, event, "processed");
  return {
    kind: "received",
    linkId: link.id as string,
    messageId: message.id as string,
    classified,
    menuIntent,
    captureReportId,
    reply,
  };
}
