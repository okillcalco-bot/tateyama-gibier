import { createClient } from "@supabase/supabase-js";
import { env, isSupabaseConfigured } from "@/lib/env";
import { isVisibleToTier } from "@/domain/board/board-service";

export const dynamic = "force-dynamic";

/**
 * 飲食店向け共有ボード（顧客閲覧ページ）。
 * 認証は注文ポータル（order-portal.html）と同じ customers.portal_token を使う。
 * ログイン不要・その店専用URL。middleware で認証リダイレクトを除外している。
 * 本番稼働中の order-portal.html には手を入れず、リンクを置くだけで導線が作れる。
 */

type Row = Record<string, unknown>;

export const metadata = { title: "館山ジビエセンター お知らせボード" };

export default async function PortalBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  const deny = (message: string) => (
    <div className="mx-auto max-w-xl p-6 text-center">
      <h1 className="mb-2 text-lg font-bold text-green-900">お知らせボード</h1>
      <p className="text-sm text-stone-600">{message}</p>
    </div>
  );

  if (!isSupabaseConfigured() || !env.supabaseServiceRoleKey) {
    return deny("現在準備中です。");
  }
  if (!token) return deny("このページは専用URLからご覧ください。");

  const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  const { data: customer } = await supabase
    .from("customers")
    .select("id, name, honorific, is_active")
    .eq("portal_token", token)
    .maybeSingle();
  if (!customer || customer.is_active === false) {
    return deny("URLが正しくないか、無効になっています。お手数ですが担当までご連絡ください。");
  }

  const { data: level } = await supabase
    .from("customer_levels")
    .select("tier")
    .eq("customer_id", customer.id)
    .maybeSingle();
  const tier = (level?.tier as string) ?? "new";

  const { data: posts } = await supabase
    .from("board_posts")
    .select("id, title, body, tags, target_tiers, inventory_snapshot, pinned, created_at")
    .eq("audience", "customer")
    .eq("status", "open")
    .is("deleted_at", null)
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(50);

  const visible = ((posts ?? []) as Row[]).filter((post) => isVisibleToTier(post, tier));

  return (
    <div className="mx-auto max-w-xl p-4">
      <header className="mb-4 text-center">
        <h1 className="text-lg font-bold text-green-900">館山ジビエセンター お知らせボード</h1>
        <p className="text-sm text-stone-500">
          {customer.name as string} {(customer.honorific as string) ?? "様"} 向けのお知らせ
        </p>
      </header>

      {visible.length ? (
        <div className="space-y-3">
          {visible.map((post) => {
            const snapshot = (post.inventory_snapshot as Row[] | null) ?? null;
            return (
              <article
                key={post.id as string}
                className={`rounded-xl border bg-white p-4 ${post.pinned ? "border-green-500" : "border-stone-200"}`}
              >
                {post.pinned ? <span className="text-xs">📌 </span> : null}
                {post.title ? (
                  <h2 className="inline text-base font-semibold">{post.title as string}</h2>
                ) : null}
                <p className="mt-1 whitespace-pre-wrap text-sm text-stone-700">
                  {post.body as string}
                </p>
                {snapshot?.length ? (
                  <div className="mt-2 rounded-lg bg-stone-50 p-2">
                    <p className="mb-1 text-xs font-semibold text-stone-500">
                      🥩 本日の精肉在庫（{String(post.created_at).slice(0, 10)}時点）
                    </p>
                    <table className="w-full text-sm">
                      <tbody>
                        {snapshot.map((item, i) => (
                          <tr key={i} className="border-t border-stone-200">
                            <td className="py-1">{item.name as string}</td>
                            <td className="py-1 text-right">
                              {item.stock_qty as number}
                              {(item.unit as string) ?? ""}
                            </td>
                            <td className="py-1 text-right">
                              {item.price ? `¥${Number(item.price).toLocaleString()}` : ""}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                <p className="mt-2 text-xs text-stone-400">
                  {String(post.created_at).slice(0, 10)}
                </p>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-stone-400">
          現在お知らせはありません。
        </p>
      )}

      <footer className="mt-8 text-center text-xs text-stone-400">
        ご注文はいつもの注文ポータルから。ご不明点はお電話ください。
      </footer>
    </div>
  );
}
