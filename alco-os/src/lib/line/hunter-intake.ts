import { getServiceDbContext } from "@/lib/db/service-context";
import { getProvider } from "@/ai/model-router";
import { classifyHunterMessage } from "@/ai/workflows/classify-hunter-message";
import {
  intakeHunterEvent,
  type HunterEventInput,
  type HunterIntakeOutcome,
} from "@/domain/hunters/hunter-message-service";
import { env } from "@/lib/env";
import { fetchDisplayName } from "./client";
import { saveLinePhoto } from "./photo";
import type { LineChannel } from "./channels";

/**
 * 捕獲者チャネルの受信処理（インフラ配線）。
 * ドメイン処理は domain/hunters/hunter-message-service.ts にあり、
 * ここでは service_role の DB・Storage・AIプロバイダを注入するだけ。
 */
export async function intakeHunterWebhookEvent(
  channel: LineChannel,
  input: HunterEventInput,
): Promise<HunterIntakeOutcome> {
  const { db, organizationId, supabase } = await getServiceDbContext();

  return intakeHunterEvent(
    {
      db,
      organizationId,
      fetchDisplayName: channel.accessToken
        ? (lineUserId) => fetchDisplayName(channel.accessToken, lineUserId)
        : undefined,
      // 「使い方」で案内する説明ページ（ログイン不要・大きい文字）
      guideUrl: env.siteUrl ? `${env.siteUrl}/guide` : "",
      savePhoto: channel.accessToken
        ? ({ lineMessageId, captureReportId }) =>
            saveLinePhoto({
              db,
              supabase,
              organizationId,
              accessToken: channel.accessToken,
              lineMessageId,
              captureReportId,
            })
        : undefined,
      classify: async ({ messageId, text, hunterName, hasLocation }) => {
        const result = await classifyHunterMessage(
          { db, provider: getProvider(), organizationId, userId: null },
          { raw_text: text, hunter_name: hunterName, has_location: hasLocation },
          { messageId },
        );
        return {
          intent: result.output.detected_intent,
          // AIの読み取りは候補のみ。確定値にしない（ai_suggestion に保存）
          suggestion: result.output.extracted as unknown as Record<string, unknown>,
          draftId: result.draftId,
        };
      },
    },
    input,
  );
}

/**
 * 捕獲者への即時返信文。
 *
 * 文面はすべてドメイン側の定型文（domain/hunters/hunter-replies.ts）で、
 * AIが書いた文章を自動送信することはない。
 * 再送・対象外・受け取らない設定のときだけ返信しない（replyToken を使わない）。
 */
export function buildHunterAutoReply(outcome: HunterIntakeOutcome): string | null {
  switch (outcome.kind) {
    case "pending":
    case "received":
      return outcome.reply;
    case "duplicate":
    case "skipped":
    case "blocked":
      return null;
  }
}

/** 返信に付ける選択肢（1タップで答えられるボタン）。無ければ空配列 */
export function buildHunterReplyChoices(
  outcome: HunterIntakeOutcome,
): { label: string; text: string }[] {
  return outcome.kind === "received" ? (outcome.choices ?? []) : [];
}
