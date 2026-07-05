import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { ingestInboxText } from "@/lib/inbox";

/**
 * 受信箱API — ALCO OS の「秘書」への汎用入口。
 *
 * メール転送・iPhoneの共有ショートカットなど、外部から届いたテキストを
 * メモとして取り込み、AI分類まで自動で行う。結果はドラフト（承認待ち）に
 * なり、勝手にタスク化はしない（中核ルール維持）。
 * ※ LINE は専用の /api/line（署名検証付き）を使う。
 *
 * 認証: INBOX_TOKEN 環境変数と一致するトークンが必要。
 *   - ヘッダー `x-inbox-token: <token>` または クエリ `?token=<token>`
 * 必要な環境変数: INBOX_TOKEN, SUPABASE_SERVICE_ROLE_KEY
 *
 * リクエスト例:
 *   POST /api/inbox
 *   { "text": "◯◯さんから見積依頼...", "title": "メール転送", "source": "email" }
 */
export async function POST(request: Request) {
  if (!env.inboxToken) {
    return NextResponse.json(
      { ok: false, error: "受信箱は無効です（INBOX_TOKEN 未設定）" },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  const token = request.headers.get("x-inbox-token") ?? url.searchParams.get("token");
  if (token !== env.inboxToken) {
    return NextResponse.json({ ok: false, error: "認証エラー" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const text = String(body?.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ ok: false, error: "text は必須です" }, { status: 400 });
  }

  try {
    const result = await ingestInboxText({
      text,
      title: String(body?.title ?? "").trim() || undefined,
      source: String(body?.source ?? "inbox").slice(0, 40),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "取り込みに失敗しました" },
      { status: 500 },
    );
  }
}
