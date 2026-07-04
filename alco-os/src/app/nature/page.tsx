import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

const OECM_LABELS: Record<string, { label: string; color: "gray" | "blue" | "amber" | "green" }> = {
  none: { label: "認証対象外", color: "gray" },
  preparing: { label: "認証準備中", color: "blue" },
  applied: { label: "申請中", color: "amber" },
  certified: { label: "認証済", color: "green" },
};

export default async function NaturePage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="自然資本" description="対象地・観察記録・証跡・レポート" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data: sites } = await supabase
    .from("v_site_activity")
    .select("*")
    .order("site_name");

  return (
    <>
      <PageHeader title="自然資本" description="対象地・観察記録・証跡・レポート" />
      <div className="space-y-3">
        {!sites?.length ? (
          <EmptyState message="対象地はまだ登録されていません。" />
        ) : (
          sites.map((site) => {
            const oecm = OECM_LABELS[site.oecm_status ?? "none"] ?? OECM_LABELS.none;
            return (
              <Card key={site.site_id}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{site.site_name}</p>
                    <p className="mt-1 text-xs text-stone-400">
                      観察記録 {site.observation_count} 件 ・管理作業 {site.action_count} 件
                      {site.last_observed_at
                        ? ` ・最終観察 ${String(site.last_observed_at).slice(0, 10)}`
                        : ""}
                    </p>
                  </div>
                  <Badge color={oecm.color}>{oecm.label}</Badge>
                </div>
              </Card>
            );
          })
        )}
      </div>
      <p className="mt-4 text-xs text-stone-400">
        レポート・提案書のAI生成は、登録済みの観察記録・管理作業のみを根拠として引用します
        （証跡IDの実在チェックあり）。証跡が不足している場合はレポートに明示されます。
      </p>
    </>
  );
}
