import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";
import { CHANNELS } from "@/ai/schemas/social.schema";
import { NewSocialProjectForm } from "./social-forms";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, { label: string; color: "gray" | "blue" | "green" | "amber" }> = {
  brief: { label: "原稿待ち", color: "gray" },
  approved: { label: "承認済み（投稿待ち）", color: "amber" },
  posted: { label: "投稿完了", color: "green" },
};

export default async function SocialPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="発信" description="一次データから各チャンネル向けの投稿文を一括生成" />
        <SetupNotice />
      </>
    );
  }
  const supabase = await createSupabaseServerClient();
  const { data: projects } = await supabase
    .from("social_projects")
    .select("id, title, source_kind, channels, posted_channels, status, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <>
      <PageHeader
        title="発信（投稿一括更新）"
        description="メモやFB投稿を、HP・Instagram・Facebook・YouTube向けに書き分けて承認 → 投稿。"
      />
      <NewSocialProjectForm />
      <div className="mt-4 space-y-3">
        {!projects?.length ? (
          <EmptyState message="まだありません。発信のもとネタ（一次データ）を登録してください。" />
        ) : (
          projects.map((project) => {
            const status = STATUS_LABELS[project.status] ?? STATUS_LABELS.brief;
            const posted = (project.posted_channels as string[]) ?? [];
            return (
              <Link key={project.id} href={`/social/${project.id}`} className="block">
                <Card className="hover:border-green-300">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{project.title}</p>
                      <p className="mt-1 text-xs text-stone-400">
                        {((project.channels as string[]) ?? [])
                          .map((c) =>
                            posted.includes(c)
                              ? `✓${CHANNELS[c as keyof typeof CHANNELS] ?? c}`
                              : (CHANNELS[c as keyof typeof CHANNELS] ?? c),
                          )
                          .join(" ・ ")}
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
