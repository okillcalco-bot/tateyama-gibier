import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getProvider } from "@/ai/model-router";
import { classifyVoiceMemo } from "@/ai/workflows/classify-voice-memo";

/**
 * 受信箱API — ALCO OS の「秘書」への入口。
 *
 * メール転送・LINE Bot・iPhoneの共有ショートカットなど、外部から届いた
 * テキストをメモとして取り込み、AI分類まで自動で行う。
 * 結果はドラフト（承認待ち）になり、勝手にタスク化はしない（中核ルール維持）。
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
  // ── 認証 ──
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
  if (!env.supabaseServiceRoleKey) {
    return NextResponse.json(
      { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY 未設定" },
      { status: 503 },
    );
  }

  // ── 入力 ──
  const body = await request.json().catch(() => null);
  const text = String(body?.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ ok: false, error: "text は必須です" }, { status: 400 });
  }
  const source = String(body?.source ?? "inbox").slice(0, 40);
  const title = String(body?.title ?? "").trim() || `受信箱（${source}）`;

  // ── 保存（サーバー専用キーで書き込み。外部入力の created_by は null） ──
  const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);
  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", "alco")
    .single();
  if (orgError || !org) {
    return NextResponse.json({ ok: false, error: "組織が見つかりません" }, { status: 500 });
  }

  const db = new SupabaseDb(supabase);
  const memo = await db.insert("voice_memos", {
    organization_id: org.id,
    title: title.slice(0, 120),
    raw_text: text.slice(0, 20_000),
    source_type: "text_memo",
    status: "new",
  });

  // ── AI分類（失敗しても取り込み自体は成功扱い。後から再分類ボタンで救済可） ──
  let classified = false;
  try {
    await classifyVoiceMemo(
      { db, provider: getProvider(), organizationId: org.id, userId: null },
      { title, raw_text: text, source_type: "text_memo" },
      { memoId: memo.id as string },
    );
    await db.update("voice_memos", memo.id as string, { status: "classified" });
    classified = true;
  } catch {
    // ai_runs に失敗記録済み。メモは new のまま残る
  }

  return NextResponse.json({ ok: true, memoId: memo.id, classified });
}
