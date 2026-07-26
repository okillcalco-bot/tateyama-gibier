import crypto from "node:crypto";
import type { LineChannel } from "./channels";

/**
 * LINE Webhook の署名検証。
 *
 * LINEは生ボディの HMAC-SHA256（base64）を x-line-signature ヘッダーで送る。
 * JSONを再シリアライズすると一致しないため、必ず生ボディを渡すこと。
 */

export function computeSignature(secret: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

/** タイミング攻撃に配慮した比較。長さが違う時点で false */
export function verifySignature(secret: string, rawBody: string, signature: string): boolean {
  if (!secret || !signature) return false;
  const expected = computeSignature(secret, rawBody);
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (signatureBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(signatureBuf, expectedBuf);
}

/**
 * 登録済みチャネルのシークレットで順に検証し、最初に一致したチャネルを返す。
 * どれとも一致しなければ null（= 401 を返す）。
 *
 * destination は検証前には信用できないため、ここでは参照しない。
 */
export function resolveChannelBySignature(
  channels: LineChannel[],
  rawBody: string,
  signature: string,
): LineChannel | null {
  for (const channel of channels) {
    if (verifySignature(channel.secret, rawBody, signature)) return channel;
  }
  return null;
}

/** 署名検証後のボディから destination を読む（検証前に呼ばないこと） */
export function readDestination(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as { destination?: unknown }).destination;
  return typeof value === "string" && value ? value : null;
}

/**
 * destination とチャネル設定の突き合わせ。
 * channelId 未設定（環境変数を入れていない）場合は照合をスキップして true。
 * 署名が既に一致しているため、これは「設定ミスの検知」であってセキュリティ境界ではない。
 */
export function matchesDestination(channel: LineChannel, destination: string | null): boolean {
  if (!channel.channelId) return true;
  if (!destination) return true;
  return channel.channelId === destination;
}
