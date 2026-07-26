import type { DbPort, Row } from "@/lib/db/port";
import { createPendingLink, findLinkByLineUser } from "./hunter-link-service";
import { matchMenuKeyword, type HunterMenuIntent } from "./hunter-keywords";
import {
  attachDetail,
  attachLocation,
  attachPhoto,
  openCaptureReport,
  readSavedFields,
  setCaptureFormFields,
} from "./capture-report-service";
import {
  FORM_TEMPLATE_LINES,
  REQUIRED_FIELD_LABELS,
  mergeFields,
  missingRequiredFields,
  parseCaptureForm,
  type CaptureFormFields,
} from "./capture-form-parser";
import { buildShareUrl, isShareLinkValid, issueShareLink } from "./capture-share-service";
import { attachReportPhoto } from "./capture-photo-service";
import {
  clearConversation,
  getConversation,
  setConversation,
} from "./conversation-state-service";
import { getAcceptanceStatus, getTodayIntakeCount } from "./gibier-status-service";
import {
  WEIGHT_MEASURE_CHOICES,
  WEIGHT_MEASURE_LABELS,
  describeWeight,
  matchWeightMeasure,
  parseWeightKg,
  setWeightMeasure,
  setWeightValue,
} from "./weight-service";
import {
  ACK_TEXT,
  acceptanceStatusReply,
  askNameReply,
  captureReportDetailSavedReply,
  REQUIRED_PHOTO_COUNT,
  cityFormReadyButPhotosReply,
  cityFormReadyReply,
  missingFieldsQuestionReply,
  reportAlreadyCompleteReply,
  weightAlreadyRecordedReply,
  weightKindQuestionReply,
  weightNotUnderstoodReply,
  weightSavedReply,
  weightSkippedReply,
  weightValueQuestionReply,
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
      /** 返信に付ける選択肢（LINEのクイックリプライ）。1タップで答えられる */
      choices?: { label: string; text: string }[];
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
  /** 「使い方」で案内する説明ページのURL（ログイン不要） */
  guideUrl?: string;
  /** 捕獲票の共有リンクを作るための公開URL（例: https://alco-os.vercel.app） */
  siteUrl?: string;
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

/** 直近24時間以内に開いた、まだ処理されていない報告を探す */
const RECENT_REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

async function findRecentOpenReport(
  db: DbPort,
  linkId: string,
  now: Date,
): Promise<Row | null> {
  const rows = await db.findMany(
    "capture_reports",
    { hunter_line_link_id: linkId, status: "pending" },
    50,
  );
  const recent = rows
    .filter((row) => {
      const created = Date.parse(String(row.created_at ?? ""));
      return !Number.isFinite(created) || now.getTime() - created < RECENT_REPORT_WINDOW_MS;
    })
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  return recent[0] ?? null;
}

/**
 * 進行中の捕獲報告を取り出す。無ければ新しく開く。
 *
 * 会話状態が切れたあと（＝リンク発行後）に写真や位置情報が届くことがあるため、
 * **直近の未処理レポートがあればそれに足す**。毎回新しい報告を作ると
 * 空の報告が量産され、捕獲者にも同じ質問を繰り返してしまう。
 * 「捕獲報告」を押したときだけ forceNew で新しく開く。
 */
async function ensureCaptureReport(
  deps: HunterIntakeDeps,
  params: {
    link: Row;
    channelId: string;
    lineUserId: string;
    existingId: string | null;
    forceNew?: boolean;
    now: Date;
  },
): Promise<Row> {
  if (params.existingId) {
    const existing = await deps.db.findById("capture_reports", params.existingId);
    if (existing && existing.status === "pending") return existing;
  }
  if (!params.forceNew) {
    const recent = await findRecentOpenReport(deps.db, params.link.id as string, params.now);
    if (recent) return recent;
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
  let choices: { label: string; text: string }[] | undefined;
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
            forceNew: true,
            now,
          });
          captureReportId = report.id as string;
          await setConversation(db, {
            organizationId,
            lineChannelId: input.channelId,
            lineUserId: input.lineUserId,
            state: "awaiting_capture_form",
            captureReportId,
            now,
          });
          reply = captureReportStartReply(FORM_TEMPLATE_LINES);
          break;
        }
        case "delivery_notice": {
          reply = deliveryNoticeReply(await getAcceptanceStatus(db));
          break;
        }
        case "acceptance_status": {
          const today = now.toISOString().slice(0, 10);
          const [status, todayCount] = await Promise.all([
            getAcceptanceStatus(db),
            getTodayIntakeCount(db, today),
          ]);
          reply = acceptanceStatusReply({ ...status, todayCount });
          break;
        }
        case "payment_status": {
          // 当面は準備中の案内のみ。問い合わせは職員一覧に残る
          reply = paymentStatusReply();
          break;
        }
        case "help": {
          reply = helpReply(deps.guideUrl ?? "");
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
        now,
      });
      captureReportId = report.id as string;

      let fileId: string | null = null;
      if (deps.savePhoto && input.messageId) {
        fileId = await deps.savePhoto({
          lineMessageId: input.messageId,
          captureReportId,
        });
      }
      if (fileId) {
        // 代表写真（0022の後方互換）+ 種別つきの一覧（0024）の両方に記録する
        await attachPhoto(db, captureReportId, fileId);
        await attachReportPhoto(db, {
          organizationId,
          captureReportId,
          fileId,
        });
      }

      await setConversation(db, {
        organizationId,
        lineChannelId: input.channelId,
        lineUserId: input.lineUserId,
        state: "awaiting_capture_form",
        captureReportId,
        now,
      });
      {
        const photoRows = await db.findMany(
          "capture_report_photos",
          { capture_report_id: captureReportId },
          50,
        );
        reply = captureReportPhotoSavedReply(photoRows.length);
      }
    } else if (hasLocation) {
      // ── 3. 位置情報（原座標を保存。表示時は必ず geo-masking を通す） ──
      const report = await ensureCaptureReport(deps, {
        link,
        channelId: input.channelId,
        lineUserId: input.lineUserId,
        existingId: conversation.captureReportId,
        now,
      });
      captureReportId = report.id as string;

      if (typeof input.latitude === "number" && typeof input.longitude === "number") {
        await attachLocation(db, captureReportId, input.latitude, input.longitude);
      }
      await setConversation(db, {
        organizationId,
        lineChannelId: input.channelId,
        lineUserId: input.lineUserId,
        state: "awaiting_capture_form",
        captureReportId,
        now,
      });
      reply = captureReportLocationSavedReply();
    } else if (
      text &&
      (conversation.state === "awaiting_capture_form" ||
        conversation.state === "awaiting_capture_detail")
    ) {
      // ── 4. 定型文（型）を読む。ラベルが1つも無ければAI分類へ回す ──
      const report = await ensureCaptureReport(deps, {
        link,
        channelId: input.channelId,
        lineUserId: input.lineUserId,
        existingId: conversation.captureReportId,
        now,
      });
      captureReportId = report.id as string;

      const parsed = parseCaptureForm(text, now);
      if (parsed.filledCount === 0) {
        // 型ではない自由文 → 本文として保存し、AIに候補を出させる
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
            // ai_runs に失敗が記録済み
          }
        }
        await attachDetail(db, captureReportId, {
          rawText: text,
          aiSuggestion: suggestion,
          sourceDraftId: draftId,
        });

        // **保存済みの内容とあわせて判定する。**
        // 直近のメッセージだけで見ると、必要な内容がそろっているのに
        // 体重の質問を最初からやり直してしまう（本番で発生した不具合）。
        const current = await db.findById("capture_reports", captureReportId);
        const savedFields = readSavedFields(current) as CaptureFormFields;
        const stillMissing = missingRequiredFields(savedFields);

        if (stillMissing.length === 0) {
          // そろっている報告への補足・雑談 → 聞き直さない
          await clearConversation(db, {
            organizationId,
            lineChannelId: input.channelId,
            lineUserId: input.lineUserId,
          });
          const token =
            typeof current?.share_token === "string" ? current.share_token : null;
          const valid = isShareLinkValid(
            token,
            typeof current?.share_expires_at === "string" ? current.share_expires_at : null,
            now,
          );
          reply = reportAlreadyCompleteReply(
            valid && deps.siteUrl ? buildShareUrl(deps.siteUrl, token!) : "",
          );
          captureReportId = null;
        } else if (
          stillMissing.includes("weightKg") ||
          stillMissing.includes("weightMeasure")
        ) {
          // 型を使わない人はこれまでどおり1つずつ聞く（体重から）
          await setConversation(db, {
            organizationId,
            lineChannelId: input.channelId,
            lineUserId: input.lineUserId,
            state: "awaiting_weight_kind",
            captureReportId,
            now,
          });
          reply = `${captureReportDetailSavedReply()}\n\n${weightKindQuestionReply()}`;
          choices = WEIGHT_MEASURE_CHOICES;
        } else {
          await setConversation(db, {
            organizationId,
            lineChannelId: input.channelId,
            lineUserId: input.lineUserId,
            state: "awaiting_capture_form",
            captureReportId,
            now,
          });
          reply = missingFieldsQuestionReply(
            stillMissing.map((key) => REQUIRED_FIELD_LABELS[key]),
          );
          choices = buildMissingChoices(stillMissing);
        }
      } else {
        // 型として読めた → 保存し、不足だけをまとめて聞く
        const saved = readSavedFields(await db.findById("capture_reports", captureReportId));
        const merged = mergeFields(saved as Partial<CaptureFormFields>, parsed.fields);
        // 捕獲日が空欄なら送信日を使う（フェーズ3の決定）
        if (!merged.captureDate) merged.captureDate = now.toISOString().slice(0, 10);

        await setCaptureFormFields(db, captureReportId, merged);
        await attachDetail(db, captureReportId, { rawText: text });

        const missing = missingRequiredFields(merged);
        if (missing.length > 0) {
          await setConversation(db, {
            organizationId,
            lineChannelId: input.channelId,
            lineUserId: input.lineUserId,
            state: "awaiting_capture_form",
            captureReportId,
            now,
          });
          reply = missingFieldsQuestionReply(missing.map((key) => REQUIRED_FIELD_LABELS[key]));
          choices = buildMissingChoices(missing);
        } else {
          const result = await completeCaptureReport(deps, {
            reportId: captureReportId,
            channelId: input.channelId,
            lineUserId: input.lineUserId,
            now,
          });
          reply = result.reply;
          captureReportId = null;
        }
      }
    } else if (text && conversation.state === "awaiting_weight_kind") {
      // ── 4-a. 体重の計測区分（センター / 処理施設 / 推定） ──
      const reportId = conversation.captureReportId;
      const measure = matchWeightMeasure(text);
      const currentReport = reportId ? await db.findById("capture_reports", reportId) : null;
      const alreadyHasWeight =
        typeof currentReport?.weight_kg === "number" &&
        typeof currentReport?.weight_measure === "string";

      if (alreadyHasWeight) {
        // 既に記録済み。数値を聞き直さない（本番で無限ループになった不具合）
        await clearConversation(db, {
          organizationId,
          lineChannelId: input.channelId,
          lineUserId: input.lineUserId,
        });
        captureReportId = null;
        reply = weightAlreadyRecordedReply(
          describeWeight(
            currentReport?.weight_kg as number,
            currentReport?.weight_measure as string,
          ),
        );
      } else if (isSkipAnswer(text)) {
        await clearConversation(db, {
          organizationId,
          lineChannelId: input.channelId,
          lineUserId: input.lineUserId,
        });
        captureReportId = null;
        reply = weightSkippedReply();
      } else if (measure && reportId) {
        await setWeightMeasure(db, reportId, measure);
        await setConversation(db, {
          organizationId,
          lineChannelId: input.channelId,
          lineUserId: input.lineUserId,
          state: "awaiting_weight_value",
          captureReportId: reportId,
          now,
        });
        reply = weightValueQuestionReply(WEIGHT_MEASURE_LABELS[measure]);
      } else {
        // 区分が読めない文は報告の続きとして保存し、もう一度たずねる
        if (reportId) await attachDetail(db, reportId, { rawText: text });
        reply = weightKindQuestionReply();
        choices = WEIGHT_MEASURE_CHOICES;
      }
    } else if (text && conversation.state === "awaiting_weight_value") {
      // ── 4-b. 体重の数値 ──
      const reportId = conversation.captureReportId;
      if (isSkipAnswer(text)) {
        await clearConversation(db, {
          organizationId,
          lineChannelId: input.channelId,
          lineUserId: input.lineUserId,
        });
        captureReportId = null;
        reply = weightSkippedReply();
      } else {
        const weightKg = parseWeightKg(text);
        if (weightKg === null) {
          reply = weightNotUnderstoodReply();
        } else {
          if (reportId) await setWeightValue(db, reportId, weightKg);
          const report = reportId ? await db.findById("capture_reports", reportId) : null;
          await clearConversation(db, {
            organizationId,
            lineChannelId: input.channelId,
            lineUserId: input.lineUserId,
          });
          captureReportId = null;
          reply = weightSavedReply(
            describeWeight(weightKg, (report?.weight_measure as string | null) ?? null),
          );
        }
      }
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
    choices,
  };
}

/** 「わからない」等の答え。無理に入力させない（高齢の捕獲者への配慮） */
function isSkipAnswer(text: string): boolean {
  const normalized = text.trim().replace(/[\s　]/g, "");
  return ["わからない", "分からない", "わかりません", "不明", "スキップ", "とばす"].some(
    (word) => normalized === word || normalized.includes(word),
  );
}

/**
 * 不足項目の答えを1タップで返せる選択肢を作る。
 * 選択肢を持つ項目のうち、最初のものを出す（場所や番号は手入力）。
 */
function buildMissingChoices(
  missing: ReturnType<typeof missingRequiredFields>,
): { label: string; text: string }[] {
  for (const field of missing) {
    switch (field) {
      case "species":
        return ["イノシシ", "シカ", "キョン"].map((v) => ({ label: v, text: `獣種：${v}` }));
      case "captureMethod":
        return ["くくり罠", "箱罠", "銃猟"].map((v) => ({ label: v, text: `捕獲方法：${v}` }));
      case "sex":
        return ["オス", "メス"].map((v) => ({ label: v, text: `性別：${v}` }));
      case "weightMeasure":
        return WEIGHT_MEASURE_CHOICES.map((c) => ({
          label: c.label,
          text: `体重の測り方：${c.text}`,
        }));
      case "finishingMethod":
        return ["銃", "刺殺", "既に死亡"].map((v) => ({ label: v, text: `止め刺し：${v}` }));
      default:
        continue;
    }
  }
  return [];
}

/**
 * 必須項目がそろったので捕獲票の共有リンクを発行し、会話を閉じる。
 * 写真が足りない場合もリンクは出す（あとから送ってもらう）。
 */
async function completeCaptureReport(
  deps: HunterIntakeDeps,
  params: { reportId: string; channelId: string; lineUserId: string; now: Date },
): Promise<{ reply: string }> {
  const { db, organizationId } = deps;

  // 既に有効なリンクがあれば作り直さない（捕獲者が受け取ったリンクを無効にしない）
  const existing = await db.findById("capture_reports", params.reportId);
  const existingToken =
    typeof existing?.share_token === "string" ? existing.share_token : null;
  const stillValid = isShareLinkValid(
    existingToken,
    typeof existing?.share_expires_at === "string" ? existing.share_expires_at : null,
    params.now,
  );
  const token = stillValid
    ? existingToken!
    : (await issueShareLink(db, params.reportId, { now: params.now })).token;
  const url = buildShareUrl(deps.siteUrl ?? "", token);

  await clearConversation(db, {
    organizationId,
    lineChannelId: params.channelId,
    lineUserId: params.lineUserId,
  });

  // 捕獲者には**枚数**で伝える。種別（尻尾を切る前／後）の仕分けは職員の作業なので、
  // 届いているのに「まだ足りない」と催促しない
  const photoRows = await db.findMany(
    "capture_report_photos",
    { capture_report_id: params.reportId },
    50,
  );
  const photoCount = photoRows.length;

  if (!url) {
    // 公開URLが未設定のときはリンクを出さない（壊れたURLを送らない）
    return { reply: "ありがとうございます。捕獲票の準備ができました。担当者からご連絡します。" };
  }
  if (photoCount < REQUIRED_PHOTO_COUNT) {
    return { reply: cityFormReadyButPhotosReply(url, photoCount) };
  }
  return { reply: cityFormReadyReply(url) };
}
