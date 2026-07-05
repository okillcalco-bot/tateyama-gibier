import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { env } from "@/lib/env";
import { ingestInboxText } from "@/lib/inbox";

/**
 * LINE Messaging API webhook — LINE公式アカウントからの秘書入口。
 *
 * 役割:
 *  1. 署名検証（LINE_CHANNEL_SECRET による HMAC-SHA256）
 *  2. テキストメッセージを ALCO OS の受信箱へ取り込み（メモ化→AI分類→承認待ち）
 *  3. GAS_WEBHOOK_URL が設定されていれば、既存のGAS秘書システムへ
 *     webhookをそのまま転送（スプレッドシート側の専務・秘書も並走できる）
 *
 * 返信ポリシー:
 *  - GASへ転送する場合は返信しない（reply token は1回しか使えず、GAS側が返信を担うため）
 *  - GAS転送なし + LINE_CHANNEL_ACCESS_TOKEN 設定時のみ、取り込み確認を返信する
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

export async function GET() {
  return NextResponse.json({ ok: true, service: "alco-os-line-webhook" });
}

export async function POST(request: Request) {
  if (!env.lineChannelSecret) {
    return NextResponse.json(
      { ok: false, error: "LINE_CHANNEL_SECRET 未設定" },
      { status: 503 },
    );
  }

  // ── 署名検証（生ボディに対して行う） ──
  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature") ?? "";
  const expected = crypto
    .createHmac("sha256", env.lineChannelSecret)
    .update(rawBody)
    .digest("base64");
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (
    signatureBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(signatureBuf, expectedBuf)
  ) {
    return NextResponse.json({ ok: false, error: "署名エラー" }, { status: 401 });
  }

  // ── 既存GAS秘書への転送（設定時のみ。失敗しても本処理は続行） ──
  if (env.gasWebhookUrl) {
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

  // ── ALCO OS への取り込み ──
  let body: { events?: unknown[] } | null = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true });
  }
  const events = Array.isArray(body?.events) ? body.events : [];

  for (const rawEvent of events) {
    const event = rawEvent as {
      type?: string;
      replyToken?: string;
      message?: { type?: string; text?: string };
    };
    if (event.type !== "message" || event.message?.type !== "text") continue;
    const text = String(event.message.text ?? "").trim();
    if (!text) continue;

    try {
      const result = await ingestInboxText({
        text,
        title: text.slice(0, 30),
        source: "line",
      });

      // 返信はGAS転送なしのときだけ（reply token の二重使用防止）
      if (!env.gasWebhookUrl && env.lineChannelAccessToken && event.replyToken) {
        const label = result.category
          ? `（分類: ${CATEGORY_LABELS[result.category] ?? result.category}）`
          : "";
        await fetch("https://api.line.me/v2/bot/message/reply", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.lineChannelAccessToken}`,
          },
          body: JSON.stringify({
            replyToken: event.replyToken,
            messages: [
              {
                type: "text",
                text: `📥 受け取りました${label}。承認待ちに追加したので、ALCO OSの「承認」タブで確認してください。`,
              },
            ],
          }),
        }).catch(() => {});
      }
    } catch {
      // 取り込み失敗でも他のイベント処理と200応答は続ける（LINEの再送地獄を防ぐ）
    }
  }

  return NextResponse.json({ ok: true });
}
