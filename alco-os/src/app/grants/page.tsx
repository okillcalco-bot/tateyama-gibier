import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, { label: string; color: "gray" | "blue" | "green" | "amber" | "red" }> = {
  draft: { label: "検討中", color: "gray" },
  preparing: { label: "準備中", color: "blue" },
  submitted: { label: "申請済", color: "amber" },
  adopted: { label: "採択", color: "green" },
  rejected: { label: "不採択", color: "red" },
  reporting: { label: "実績報告中", color: "blue" },
  completed: { label: "完了", color: "gray" },
};

export default async function GrantsPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="補助金" description="申請案件・要件チェック・ドラフト生成" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data: projects } = await supabase
    .from("grant_projects")
    .select(
      "id, name, target_business, status, requested_amount, adopted_amount, grant_requirements(id, is_met)",
    )
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <>
      <PageHeader title="補助金" description="申請案件・要件チェック・ドラフト生成" />
      <div className="space-y-3">
        {!projects?.length ? (
          <EmptyState message="補助金案件はまだありません。" />
        ) : (
          projects.map((project) => {
            const status = STATUS_LABELS[project.status] ?? STATUS_LABELS.draft;
            const reqs = (project.grant_requirements ?? []) as { is_met: boolean | null }[];
            const met = reqs.filter((r) => r.is_met === true).length;
            return (
              <Card key={project.id}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{project.name}</p>
                    <p className="mt-1 text-xs text-stone-400">
                      {project.requested_amount
                        ? `申請額 ${Number(project.requested_amount).toLocaleString()}円`
                        : ""}
                      {reqs.length ? ` ・要件充足 ${met}/${reqs.length}` : ""}
                    </p>
                  </div>
                  <Badge color={status.color}>{status.label}</Badge>
                </div>
              </Card>
            );
          })
        )}
      </div>
      <p className="mt-4 text-xs text-stone-400">
        申請書ドラフトはAIが生成し、承認センターでのレビュー後に文書として確定します。
        AI生成文をそのまま提出しない運用ルールを前提としています。
      </p>
    </>
  );
}
