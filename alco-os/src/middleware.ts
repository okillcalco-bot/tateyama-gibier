import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { env, isSupabaseConfigured } from "@/lib/env";

/**
 * 認証ミドルウェア。
 * - Supabase セッションのリフレッシュ（Server Component が新鮮なセッションを読めるように）
 * - 未ログインなら /login へリダイレクト
 * Supabase 未設定の開発環境では素通しする（セットアップ案内が画面に出る）。
 */
export async function middleware(request: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.next();
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

  // 飲食店向けボードはトークン式（ログイン不要）。認証リダイレクトから除外
  if (request.nextUrl.pathname.startsWith("/portal")) {
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
