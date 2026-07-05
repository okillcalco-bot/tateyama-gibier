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

  const [tasks, drafts, grants, deals, sites] = await Promise.all([
    supabase.from("v_open_tasks").select("*"),
    supabase.from("v_pending_drafts").select("*"),
    supabase.from("v_grant_pipeline").select("*"),
    supabase.from("v_deal_pipeline").select("*"),
    supabase.from("v_site_activity").select("*"),
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
          <CardTitle>ジビエ基幹（既存システム）</CardTitle>
          <p className="text-sm text-stone-500">
            捕獲頭数・在庫・受注などのジビエKPIは、既存ジビエ基幹システムとのDB統合後にここへ表示します
            （docs/09-gibier-integration.md 参照）。
          </p>
        </Card>
      </div>
    </>
  );
}
