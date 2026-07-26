import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { env, isSupabaseConfigured } from "@/lib/env";

/**
 * 認証ミドルウェア。
 * - Supabase セッションのリフレッシュ（Server Component が新鮮なセッションを読めるように）
 * - 未ログインなら /login へリダイレクト
 * Supabase 未設定の開発環境では素通しする（セットアップ案内が画面に出る）。
 *
 * 除外:
 * - /api/*   外部システム（LINE Webhook・iPhoneショートカット等）が叩く。
 *            セッションを持たないためリダイレクトすると必ず失敗する
 * - /portal  飲食店ボード（customers.portal_token 認証）
 * - /support 応援ページ（ログイン不要の公開ページ）
 */
export async function middleware(request: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.next();
  }

  // 外部システムからのAPI（LINE Webhook / 受信箱など）はブラウザのセッションを
  // 持たない。ここでログイン画面へリダイレクトすると webhook が 307 を返して
  // 失敗するため、/api/* は認証リダイレクトの対象外にする。
  // 認証は各ルートハンドラ側で行う（/api/line = LINE署名検証、
  // /api/inbox = INBOX_TOKEN）。
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // 公開ページ（飲食店ボード=トークン式 / 応援ページ）は認証リダイレクトから除外
  if (
    request.nextUrl.pathname.startsWith("/portal") ||
    request.nextUrl.pathname.startsWith("/support")
  ) {
    return response;
  }

  const isLoginPage = request.nextUrl.pathname.startsWith("/login");
  if (!user && !isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (user && isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
