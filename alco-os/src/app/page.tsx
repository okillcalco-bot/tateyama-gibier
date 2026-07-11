import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth";
import { Card, CardTitle, PageHeader, SetupNotice, Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

/** 経営ダッシュボード（MVP）。集計は 0008_dashboard_views.sql のビューを使う。 */
export default async function DashboardPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="ダッシュボード" description="経営の視界を一画面に" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  // 初回アクセス時にプロフィールを自動作成する（最初のユーザー = owner）。
  // これを先に行わないと RLS により以降のクエリが空になる。
  const user = await getCurrentUser(supabase);

  const [tasks, drafts, grants, deals, sites, gibierIntake, gibierInventory, gibierSales, board] =
    await Promise.all([
      supabase.from("v_open_tasks").select("*"),
      supabase.from("v_pending_drafts").select("*"),
      supabase.from("v_grant_pipeline").select("*"),
      supabase.from("v_deal_pipeline").select("*"),
      supabase.from("v_site_activity").select("*"),
      supabase.from("v_gibier_intake_monthly").select("*"),
      supabase.from("v_gibier_inventory").select("*"),
      supabase.from("v_gibier_sales_monthly").select("*"),
      supabase
        .from("board_posts")
        .select("id, title, body, tags, pinned, created_at")
        .eq("audience", "staff")
        .eq("status", "open")
        .is("deleted_at", null)
        .order("pinned", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(3),
    ]);

  const openTasks = (tasks.data ?? []).reduce(
    (sum, row) => sum + Number(row.open_count ?? 0) + Number(row.in_progress_count ?? 0),
    0,
  );
  const overdue = (tasks.data ?? []).reduce((sum, row) => sum + Number(row.overdue_count ?? 0), 0);
  const pendingDrafts = (drafts.data ?? []).reduce(
    (sum, row) => sum + Number(row.pending_count ?? 0),
    0,
  );

  // ── ジビエ基幹 KPI（既存システムのデータを読み取り専用ビューで集計） ──
  const thisMonth = `${new Date().toISOString().slice(0, 7)}-01`;
  const intakeThisMonth = (gibierIntake.data ?? []).filter((row) => row.month === thisMonth);
  const intakeHeads = intakeThisMonth.reduce((sum, row) => sum + Number(row.head_count ?? 0), 0);
  const intakeTotalHeads = (gibierIntake.data ?? []).reduce(
    (sum, row) => sum + Number(row.head_count ?? 0),
    0,
  );
  const stockValue = (gibierInventory.data ?? []).reduce(
    (sum, row) => sum + Number(row.stock_value ?? 0),
    0,
  );
  const stockItems = (gibierInventory.data ?? []).filter(
    (row) => Number(row.stock_qty ?? 0) > 0,
  ).length;
  const salesThisMonth = (gibierSales.data ?? [])
    .filter((row) => row.month === thisMonth)
    .reduce((sum, row) => sum + Number(row.total_sales ?? 0), 0);

  return (
    <>
      <PageHeader
        title="ダッシュボード"
        description={user ? `経営の視界を一画面に ・${user.displayName} さん` : "経営の視界を一画面に"}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardTitle>未処理タスク</CardTitle>
          <p className="text-2xl font-bold">{openTasks}</p>
          {overdue > 0 ? <Badge color="red">期限超過 {overdue}</Badge> : null}
        </Card>
        <Card>
          <CardTitle>承認待ちドラフト</CardTitle>
          <p className="text-2xl font-bold">{pendingDrafts}</p>
        </Card>
        <Card>
          <CardTitle>補助金案件</CardTitle>
          <p className="text-2xl font-bold">
            {(grants.data ?? []).reduce((sum, row) => sum + Number(row.project_count ?? 0), 0)}
          </p>
        </Card>
        <Card>
          <CardTitle>CRM案件</CardTitle>
          <p className="text-2xl font-bold">
            {(deals.data ?? []).reduce((sum, row) => sum + Number(row.deal_count ?? 0), 0)}
          </p>
        </Card>
      </div>

      {(board.data ?? []).length ? (
        <Card className="mt-4">
          <div className="flex items-center justify-between">
            <CardTitle>📋 共有ボード（最新）</CardTitle>
            <Link href="/board" className="text-xs text-green-700 underline">
              すべて見る →
            </Link>
          </div>
          <ul className="divide-y divide-stone-100 text-sm">
            {(board.data ?? []).map((post) => (
              <li key={post.id} className="py-2">
                {post.pinned ? "📌 " : ""}
                {post.title ? <span className="font-medium">{post.title} — </span> : null}
                <span className="text-stone-600">
                  {String(post.body).slice(0, 60)}
                  {String(post.body).length > 60 ? "…" : ""}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Card>
          <CardTitle>自然資本サイト</CardTitle>
          <ul className="divide-y divide-stone-100 text-sm">
            {(sites.data ?? []).map((site) => (
              <li key={site.site_id} className="flex items-center justify-between py-2">
                <span>{site.site_name}</span>
                <span className="text-xs text-stone-400">
                  観察 {site.observation_count} / 作業 {site.action_count}
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardTitle>ジビエ基幹（既存システム連携）</CardTitle>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-xs text-stone-400">今月の捕獲</p>
              <p className="text-xl font-bold">{intakeHeads}頭</p>
            </div>
            <div>
              <p className="text-xs text-stone-400">在庫金額</p>
              <p className="text-xl font-bold">{stockValue.toLocaleString()}円</p>
            </div>
            <div>
              <p className="text-xs text-stone-400">今月の売上</p>
              <p className="text-xl font-bold">{salesThisMonth.toLocaleString()}円</p>
            </div>
          </div>
          {intakeThisMonth.length > 0 ? (
            <p className="mt-2 text-xs text-stone-500">
              内訳:{" "}
              {intakeThisMonth
                .map((row) => `${row.species ?? "不明"} ${row.head_count}頭`)
                .join(" ・")}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-stone-400">
            累計 {intakeTotalHeads}頭 ・在庫あり商品 {stockItems}点
            （個体台帳・完成品在庫・受注から自動集計）
          </p>
        </Card>
      </div>
    </>
  );
}
