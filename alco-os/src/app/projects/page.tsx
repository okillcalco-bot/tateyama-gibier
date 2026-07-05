import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

const PHASE_STATUS: Record<string, { label: string; color: "gray" | "blue" | "green" | "red" }> = {
  planned: { label: "予定", color: "gray" },
  in_progress: { label: "進行中", color: "blue" },
  done: { label: "完了", color: "green" },
  blocked: { label: "停滞", color: "red" },
};

export default async function ProjectsPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="プロジェクト" description="ROKA改修・拠点整備・行政調整の一元管理" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data: projects } = await supabase
    .from("projects")
    .select(
      "id, name, project_type, status, project_phases(id, name, status, sort_order), project_issues(id, status)",
    )
    .is("deleted_at", null)
    .eq("status", "active")
    .order("created_at", { ascending: false });

  return (
    <>
      <PageHeader title="プロジェクト" description="ROKA改修・拠点整備・行政調整の一元管理" />
      <div className="space-y-3">
        {!projects?.length ? (
          <EmptyState message="進行中のプロジェクトはありません。" />
        ) : (
          projects.map((project) => {
            const phases = ((project.project_phases ?? []) as {
              id: string;
              name: string;
              status: string;
              sort_order: number | null;
            }[]).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
            const openIssues = ((project.project_issues ?? []) as { status: string }[]).filter(
              (issue) => issue.status === "open",
            ).length;
            return (
              <Card key={project.id}>
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{project.name}</p>
                  {openIssues > 0 ? <Badge color="red">未解決課題 {openIssues}</Badge> : null}
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {phases.map((phase) => {
                    const status = PHASE_STATUS[phase.status] ?? PHASE_STATUS.planned;
                    return (
                      <span key={phase.id} className="inline-flex items-center gap-1 text-xs">
                        <Badge color={status.color}>{phase.name}</Badge>
                      </span>
                    );
                  })}
                </div>
              </Card>
            );
          })
        )}
      </div>
    </>
  );
}
