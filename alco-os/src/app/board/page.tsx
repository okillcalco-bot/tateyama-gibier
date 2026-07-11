import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth";
import { Card, CardTitle, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";
import { CUSTOMER_TIERS } from "@/domain/board/board-service";
import {
  NewBoardPostForm,
  ArchiveBoardPostButton,
  CustomerTierSelect,
  StaffRoleInput,
} from "./board-forms";

export const dynamic = "force-dynamic";

/**
 * 共有ボード。
 * - スタッフ向け: 代表からの共有・指示。staff.role（役割）で宛先を絞れる
 * - 飲食店向け: 精肉状況・おすすめ・搬入情報。信頼度（初回/リピーター/太客）で絞れる。
 *   飲食店側は /portal/board?token=（注文ポータルと同じ portal_token）で閲覧する
 * - タグは本文から自動付与 + 手動。検索・タグ絞り込み対応
 */

type Row = Record<string, unknown>;

const ROLE_SUGGESTIONS = ["解体・精肉", "配送", "受注・販売", "捕獲対応", "清掃・衛生", "事務・経理"];

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ aud?: string; q?: string; tag?: string }>;
}) {
  const params = await searchParams;
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="共有ボード" />
        <SetupNotice />
      </>
    );
  }
  const audience = params.aud === "customer" ? "customer" : "staff";
  const q = (params.q ?? "").trim().slice(0, 100);
  const tag = (params.tag ?? "").trim();

  const supabase = await createSupabaseServerClient();
  await getCurrentUser(supabase);

  let query = supabase
    .from("board_posts")
    .select("*")
    .eq("audience", audience)
    .eq("status", "open")
    .is("deleted_at", null)
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100);
  if (q) query = query.or(`title.ilike.%${q}%,body.ilike.%${q}%`);
  if (tag) query = query.contains("tags", [tag]);
  const { data: posts } = await query;
  const postRows = (posts ?? []) as Row[];

  const [{ data: staff }, { data: customers }, { data: levels }] = await Promise.all([
    supabase
      .from("staff")
      .select("id, name, role")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("name"),
    audience === "customer"
      ? supabase
          .from("customers")
          .select("id, name, portal_token")
          .eq("is_active", true)
          .order("name")
          .limit(200)
      : Promise.resolve({ data: [] }),
    audience === "customer"
      ? supabase.from("customer_levels").select("customer_id, tier")
      : Promise.resolve({ data: [] }),
  ]);
  const staffRows = (staff ?? []) as Row[];
  const roles = [...new Set(staffRows.map((s) => (s.role as string) ?? "").filter(Boolean))];
  const tierByCustomer = new Map(
    ((levels ?? []) as Row[]).map((l) => [l.customer_id as string, l.tier as string]),
  );

  // 表示中の投稿に付いているタグ（絞り込みチップ用）
  const allTags = [...new Set(postRows.flatMap((p) => (p.tags as string[]) ?? []))];

  const tabClass = (active: boolean) =>
    `rounded-full px-4 py-1.5 text-sm font-semibold ${
      active ? "bg-green-700 text-white" : "border border-stone-300 text-stone-600"
    }`;
  const keepParams = (aud: string) =>
    `/board?aud=${aud}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  return (
    <>
      <PageHeader
        title="共有ボード"
        description="スタッフへの共有・指示と、飲食店へのお知らせ。タグ自動付与・検索つき。"
      />

      <div className="space-y-4">
        <div className="flex gap-2">
          <Link href={keepParams("staff")} className={tabClass(audience === "staff")}>
            👥 スタッフ向け
          </Link>
          <Link href={keepParams("customer")} className={tabClass(audience === "customer")}>
            🍽 飲食店向け
          </Link>
        </div>

        <NewBoardPostForm audience={audience} roles={roles} />

        {/* 検索・タグ絞り込み */}
        <form action="/board" className="flex gap-2">
          <input type="hidden" name="aud" value={audience} />
          <input
            name="q"
            defaultValue={q}
            placeholder="検索（本文・タイトル）"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
          />
          <button className="rounded-lg border border-green-700 px-4 py-2 text-sm font-semibold text-green-700">
            検索
          </button>
        </form>
        {allTags.length ? (
          <div className="flex flex-wrap gap-1.5">
            {tag ? (
              <Link
                href={keepParams(audience)}
                className="rounded-full bg-stone-700 px-3 py-1 text-xs font-semibold text-white"
              >
                ✕ {tag}
              </Link>
            ) : null}
            {allTags
              .filter((t) => t !== tag)
              .map((t) => (
                <Link
                  key={t}
                  href={`${keepParams(audience)}&tag=${encodeURIComponent(t)}`}
                  className="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-600 hover:bg-green-50"
                >
                  #{t}
                </Link>
              ))}
          </div>
        ) : null}

        {/* 投稿一覧 */}
        {postRows.length ? (
          <div className="space-y-3">
            {postRows.map((post) => {
              const targets =
                audience === "staff"
                  ? ((post.target_roles as string[]) ?? [])
                  : ((post.target_tiers as string[]) ?? []).map(
                      (t) => CUSTOMER_TIERS[t as keyof typeof CUSTOMER_TIERS] ?? t,
                    );
              const snapshot = (post.inventory_snapshot as Row[] | null) ?? null;
              return (
                <Card key={post.id as string} className={post.pinned ? "border-green-400" : ""}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      {post.pinned ? <span className="mr-1 text-xs">📌</span> : null}
                      {post.title ? <span className="font-semibold">{post.title as string}</span> : null}
                      <p className="mt-1 whitespace-pre-wrap text-sm text-stone-700">
                        {post.body as string}
                      </p>
                    </div>
                    <ArchiveBoardPostButton postId={post.id as string} />
                  </div>
                  {snapshot?.length ? (
                    <details className="mt-2 rounded-lg bg-stone-50 p-2 text-sm">
                      <summary className="cursor-pointer text-xs font-semibold text-stone-500">
                        🥩 添付の精肉在庫（投稿時点・{snapshot.length}品）
                      </summary>
                      <table className="mt-1 w-full text-xs">
                        <tbody>
                          {snapshot.map((item, i) => (
                            <tr key={i} className="border-t border-stone-200">
                              <td className="py-0.5">{item.name as string}</td>
                              <td className="py-0.5 text-right">
                                {item.stock_qty as number}
                                {(item.unit as string) ?? ""}
                              </td>
                              <td className="py-0.5 text-right">
                                {item.price ? `¥${Number(item.price).toLocaleString()}` : ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </details>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {((post.tags as string[]) ?? []).map((t) => (
                      <Link key={t} href={`${keepParams(audience)}&tag=${encodeURIComponent(t)}`}>
                        <Badge color="gray">#{t}</Badge>
                      </Link>
                    ))}
                    <Badge color={targets.length ? "blue" : "green"}>
                      {targets.length ? `宛先: ${targets.join("・")}` : audience === "staff" ? "全員" : "全店"}
                    </Badge>
                    <span className="text-xs text-stone-400">
                      {String(post.created_at).slice(0, 10)}
                    </span>
                  </div>
                </Card>
              );
            })}
          </div>
        ) : (
          <EmptyState message={q || tag ? "条件に合う投稿がありません。" : "投稿はまだありません。"} />
        )}

        {/* 管理セクション */}
        {audience === "staff" ? (
          <Card>
            <CardTitle>スタッフの役割（宛先の絞り込みに使います）</CardTitle>
            <datalist id="role-suggestions">
              {ROLE_SUGGESTIONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <div className="space-y-2">
              {staffRows.map((s) => (
                <StaffRoleInput
                  key={s.id as string}
                  staffId={s.id as string}
                  name={s.name as string}
                  currentRole={(s.role as string) ?? ""}
                />
              ))}
            </div>
          </Card>
        ) : (
          <Card>
            <CardTitle>飲食店の信頼度と閲覧リンク</CardTitle>
            <p className="mb-2 text-xs text-stone-400">
              信頼度で投稿の宛先を絞れます。閲覧リンクは注文ポータルと同じトークン式で、
              その店だけの専用URLです（LINE等で共有してください）。
            </p>
            <div className="space-y-2 text-sm">
              {((customers ?? []) as Row[]).map((c) => (
                <div key={c.id as string} className="flex flex-wrap items-center gap-2">
                  <span className="w-40 shrink-0 font-medium">{c.name as string}</span>
                  <CustomerTierSelect
                    customerId={c.id as string}
                    current={tierByCustomer.get(c.id as string) ?? "new"}
                  />
                  <code className="break-all rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-500">
                    /portal/board?token={c.portal_token as string}
                  </code>
                </div>
              ))}
              {!(customers ?? []).length ? (
                <p className="text-xs text-stone-400">顧客が未登録です。</p>
              ) : null}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
