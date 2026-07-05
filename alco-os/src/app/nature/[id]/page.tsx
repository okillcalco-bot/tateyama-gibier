import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, CardTitle, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";
import { ObservationForm, ManagementActionForm, GenerateReportButton } from "../nature-forms";

export const dynamic = "force-dynamic";

/** 対象地 詳細: 観察記録（写真・GPS）・管理作業・レポート生成 */
export default async function SiteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="対象地" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const [{ data: site }, { data: observations }, { data: actions }] = await Promise.all([
    supabase.from("sites").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("biodiversity_observations")
      .select("id, observed_at, species_name, taxon_group, count, note, photo_file_id, lat, lng")
      .eq("site_id", id)
      .order("observed_at", { ascending: false })
      .limit(50),
    supabase
      .from("management_actions")
      .select("id, action_date, action_type, description, hours")
      .eq("site_id", id)
      .order("action_date", { ascending: false })
      .limit(50),
  ]);

  if (!site) notFound();

  return (
    <>
      <PageHeader
        title={site.name}
        description={[site.address, site.area_ha ? `${site.area_ha}ha` : null]
          .filter(Boolean)
          .join(" ・")}
      />

      <div className="space-y-4">
        <Card>
          <CardTitle>観察を記録（現場入力）</CardTitle>
          <ObservationForm siteId={id} />
        </Card>

        <Card>
          <CardTitle>観察記録（{observations?.length ?? 0}件）</CardTitle>
          {observations?.length ? (
            <ul className="divide-y divide-stone-100 text-sm">
              {observations.map((observation) => (
                <li key={observation.id} className="py-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {observation.species_name}
                      {observation.count ? ` × ${observation.count}` : ""}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-stone-400">
                      {observation.photo_file_id ? "📷" : ""}
                      {observation.lat ? "📍" : ""}
                      {String(observation.observed_at).slice(0, 10)}
                    </span>
                  </div>
                  <p className="text-xs text-stone-500">
                    {observation.taxon_group ?? ""}
                    {observation.note ? ` ・${observation.note}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState message="観察記録はまだありません。" />
          )}
        </Card>

        <Card>
          <CardTitle>管理作業を記録</CardTitle>
          <ManagementActionForm siteId={id} />
          {actions?.length ? (
            <ul className="mt-3 divide-y divide-stone-100 text-sm">
              {actions.map((action) => (
                <li key={action.id} className="flex items-center justify-between py-2">
                  <span>
                    <Badge color="blue">{action.action_type}</Badge>{" "}
                    {action.description ?? ""}
                  </span>
                  <span className="text-xs text-stone-400">
                    {action.action_date}
                    {action.hours ? ` ・${action.hours}h` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>

        <Card>
          <CardTitle>レポート・提案書</CardTitle>
          <GenerateReportButton siteId={id} />
        </Card>
      </div>
    </>
  );
}
