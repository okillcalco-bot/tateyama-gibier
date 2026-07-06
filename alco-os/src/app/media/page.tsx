import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";
import { NewMediaForm } from "./media-forms";

export const dynamic = "force-dynamic";

const KIND_LABELS: Record<string, string> = {
  presentation: "プレゼン",
  youtube_video: "YouTube動画",
};

const STATUS_LABELS: Record<string, { label: string; color: "gray" | "blue" | "green" | "amber" }> = {
  brief: { label: "企画中", color: "gray" },
  approved: { label: "構成確定", color: "green" },
  rendering: { label: "制作中", color: "blue" },
  uploaded: { label: "アップ済（非公開）", color: "amber" },
  published: { label: "公開済", color: "green" },
};

export default async function MediaPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="メディア" description="プレゼン資料・YouTube動画の企画から成果物まで" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data: projects } = await supabase
    .from("media_projects")
    .select("id, kind, title, target_audience, duration_minutes, status, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <>
      <PageHeader title="メディア" description="プレゼン資料・YouTube動画の企画から成果物まで" />
      <NewMediaForm />
      <div className="mt-4 space-y-3">
        {!projects?.length ? (
          <EmptyState message="企画はまだありません。上のボタンから最初の企画を登録してください。" />
        ) : (
          projects.map((project) => {
            const status = STATUS_LABELS[project.status] ?? STATUS_LABELS.brief;
            return (
              <Link key={project.id} href={`/media/${project.id}`} className="block">
                <Card className="hover:border-green-300">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{project.title}</p>
                      <p className="mt-1 text-xs text-stone-400">
                        {KIND_LABELS[project.kind] ?? project.kind}
                        {project.duration_minutes ? ` ・${project.duration_minutes}分` : ""}
                        {project.target_audience ? ` ・${project.target_audience}` : ""}
                      </p>
                    </div>
                    <Badge color={status.color}>{status.label}</Badge>
                  </div>
                </Card>
              </Link>
            );
          })
        )}
      </div>
    </>
  );
}
