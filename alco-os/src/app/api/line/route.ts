import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { ingestInboxText } from "@/lib/inbox";
import { resolveLineChannels, type LineChannel } from "@/lib/line/channels";
import { recordLineChannelSighting } from "@/lib/line/registry";
import {
  matchesDestination,
  readDestination,
  resolveChannelBySignature,
} from "@/lib/line/verify";
import { replyMessage, textMessage, textMessageWithChoices } from "@/lib/line/client";
import {
  buildHunterAutoReply,
  buildHunterReplyChoices,
  intakeHunterWebhookEvent,
} from "@/lib/line/hunter-intake";
import { handleStaffGroupEvent, notifyStaffGroupsOfDelivery } from "@/lib/line/staff-group";

/**
 * LINE Messaging API webhook — 複数チャネル共用の入口。
 *
 * 対応チャネル（既存のLINE公式アカウントをそのまま使う。ID・QRコードは変更しない）:
 *  - 秘書チャネル : 従来どおり GAS秘書へ転送 + 受信箱へメモ化（挙動を変えない）
 *  - 捕獲者チャネル: GASへ転送せず ALCO OS が処理
 *                    署名検証 → userId取得 → hunter_line_links 照合
 *                    → イベント保存・重複確認
 *                    → リッチメニューのキーワード分岐（捕獲報告 / 搬入連絡 /
 *                      受入状況 / 買取状況 / 使い方）
 *                    → 写真は Storage+files、位置情報は座標を保存
 *                    → 自由文はAI分類（候補のみ・generated_drafts）
 *                    → **必ず即時返信**し、職員が /line と /gibier/reports で確認
 *
 * チャネルの特定（重要）:
 *  destination は署名検証を通ったボディの中にしか無いため、検証前には信用しない。
 *  登録済み全チャネルのシークレットで順に署名検証し、成功したチャネルを送信元とする。
 *  → **Bot User ID（destination）の設定は不要**。
 *  destination が読めた場合は台帳（line_channel_registry）へ自動記録し、
 *  環境変数に設定されているときだけ整合性チェックに使う。
 *
 * 返信ポリシー（replyToken は1回のみ有効）:
 *  - 秘書チャネル + GAS転送あり → ALCO OS は返信しない（GASが返信する）
 *  - それ以外                   → ALCO OS が1イベントにつき1回だけ返信する
 *
 * LINE Developers の Webhook URL: https://<本番ドメイン>/api/line
 */

const CATEGORY_LABELS: Record<string, string> = {
  task: "タスク",
  meeting_minutes: "議事録",
  grant_material: "補助金素材",
  nature_record: "自然記録",
  gibier_operation: "ジビエ業務",
  crm_follow_up: "営業フォロー",
  roka_project: "ROKA",
  idea: "アイデア",
  personal_reminder: "リマインダー",
  unclear: "要確認",
};

interface LineEvent {
  type?: string;
  webhookEventId?: string;
  replyToken?: string;
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
  message?: {
    id?: string;
    type?: string;
    text?: string;
    latitude?: number;
    longitude?: number;
  };
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "alco-os-line-webhook" });
}

export async function POST(request: Request) {
  const channels = resolveLineChannels();
  if (channels.length === 0) {
    return NextResponse.json(
      { ok: false, error: "LINEチャネル未設定（LINE_SECRETARY_* / LINE_HUNTER_*）" },
      { status: 503 },
    );
  }

  // ── 署名検証（生ボディに対して行う。ここでチャネルも確定する） ──
  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature") ?? "";
  const channel = resolveChannelBySignature(channels, rawBody, signature);
  if (!channel) {
    return NextResponse.json({ ok: false, error: "署名エラー" }, { status: 401 });
  }

  let body: { events?: unknown[]; destination?: string } | null = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true });
  }

  // destination はチャネル特定に使わない（署名で既に確定している）。
  // 台帳に自動記録して、職員が画面で Bot User ID を確認できるようにする。
  const destination = readDestination(body);
  await recordLineChannelSighting(channel, destination);

  // 環境変数にIDを設定している場合だけ、設定ミスの検知として突き合わせる
  if (!matchesDestination(channel, destination)) {
    return NextResponse.json({ ok: true, note: "destination unmatched" });
  }

  // ── 既存GAS秘書への転送（秘書チャネルのみ。失敗しても本処理は続行） ──
  if (channel.forwardToGas && env.gasWebhookUrl) {
    try {
      await fetch(env.gasWebhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-line-signature": signature,
        },
        body: rawBody,
        redirect: "follow",
      });
    } catch {
      // GAS側の障害でLINE webhookを失敗させない
    }
  }

  const events = (Array.isArray(body?.events) ? body.events : []) as LineEvent[];

  // replyToken の二重使用防止（1トークン1回まで）
  const usedReplyTokens = new Set<string>();
  const canReply = (event: LineEvent): event is LineEvent & { replyToken: string } => {
    if (channel.replyBy !== "alco_os") return false;
    if (!channel.accessToken || !event.replyToken) return false;
    return !usedReplyTokens.has(event.replyToken);
  };
  const reply = async (
    event: LineEvent & { replyToken: string },
    text: string,
    choices: { label: string; text: string }[] = [],
  ) => {
    usedReplyTokens.add(event.replyToken);
    const message = choices.length > 0 ? textMessageWithChoices(text, choices) : textMessage(text);
    await replyMessage(channel.accessToken, event.replyToken, [message]);
  };

  for (const event of events) {
    try {
      if (channel.key === "hunter") {
        await handleHunterEvent(channel, event, canReply, reply);
      } else {
        await handleSecretaryEvent(event, canReply, reply);
      }
    } catch {
      // 1件の失敗で他イベントと200応答を止めない（LINEの再送地獄を防ぐ）
    }
  }

  return NextResponse.json({ ok: true });
}

type CanReply = (event: LineEvent) => event is LineEvent & { replyToken: string };
type Reply = (
  event: LineEvent & { replyToken: string },
  text: string,
  choices?: { label: string; text: string }[],
) => Promise<void>;

/** 秘書チャネル: 従来どおりテキストを受信箱へ取り込む */
async function handleSecretaryEvent(
  event: LineEvent,
  canReply: CanReply,
  reply: Reply,
): Promise<void> {
  if (event.type !== "message" || event.message?.type !== "text") return;
  const text = String(event.message.text ?? "").trim();
  if (!text) return;

  const result = await ingestInboxText({
    text,
    title: text.slice(0, 30),
    source: "line",
  });

  if (canReply(event)) {
    const label = result.category
      ? `（分類: ${CATEGORY_LABELS[result.category] ?? result.category}）`
      : "";
    await reply(
      event,
      `📥 受け取りました${label}。承認待ちに追加したので、ALCO OSの「承認」タブで確認してください。`,
    );
  }
}

/** 捕獲者チャネル: 照合・保存・分類。GASへは転送しない */
async function handleHunterEvent(
  channel: LineChannel,
  event: LineEvent,
  canReply: CanReply,
  reply: Reply,
): Promise<void> {
  const webhookEventId = String(event.webhookEventId ?? "").trim();
  const messageType = event.message?.type ?? null;

  // ── グループ・複数人トークからのイベント ──
  // **業務処理しない**（誤爆防止）。招待と「登録」「解除」だけに反応する。
  const groupId = event.source?.groupId ?? event.source?.roomId ?? null;
  if (groupId) {
    const groupReply = await handleStaffGroupEvent(channel, {
      eventType: String(event.type ?? "unknown"),
      lineGroupId: groupId,
      text: messageType === "text" ? (event.message?.text ?? null) : null,
    });
    if (groupReply && canReply(event)) {
      await reply(event, groupReply);
    }
    return;
  }

  const outcome = await intakeHunterWebhookEvent(channel, {
    // 保存する識別子は環境変数に依存しない安定ラベル（0023）
    channelId: channel.ref,
    channelKey: channel.key,
    // webhookEventId が無い場合はメッセージIDで代用する（冪等性の鍵）
    webhookEventId: webhookEventId || `msg-${event.message?.id ?? ""}`,
    eventType: String(event.type ?? "unknown"),
    messageType,
    messageId: event.message?.id ?? null,
    lineUserId: event.source?.userId ?? null,
    text: messageType === "text" ? (event.message?.text ?? null) : null,
    hasLocation: messageType === "location",
    // 原座標。保存はするが、画面表示・出力は必ず geo-masking を通す（docs/10）
    latitude: typeof event.message?.latitude === "number" ? event.message.latitude : null,
    longitude: typeof event.message?.longitude === "number" ? event.message.longitude : null,
  });

  const autoReply = buildHunterAutoReply(outcome);
  if (autoReply && canReply(event)) {
    await reply(event, autoReply, buildHunterReplyChoices(outcome));
  }

  // 搬入連絡はスタッフのグループへも知らせる（内容は最小限）
  if (outcome.kind === "received" && outcome.menuIntent === "delivery_notice") {
    await notifyStaffGroupsOfDelivery(channel, { hunterName: outcome.hunterName ?? null });
  }
}
