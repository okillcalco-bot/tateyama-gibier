import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, CardTitle, PageHeader, SetupNotice, Badge } from "@/components/ui";
import { socialPostsOutputSchema, CHANNELS, type ChannelKey } from "@/ai/schemas/social.schema";
import { GenerateSocialButton, ChannelPostBlock } from "../social-forms";

export const dynamic = "force-dynamic";

const SOURCE_LABELS: Record<string, string> = {
  memo: "メモ",
  facebook: "個人FB投稿",
  video: "動画の文字起こし",
  audio: "音声の文字起こし",
};

export default async function SocialDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="発信" />
        <SetupNotice />
      </>
    );
  }
  const supabase = await createSupabaseServerClient();
  const { data: project } = await supabase
    .from("social_projects")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!project) notFound();

  const channels = (project.channels as ChannelKey[]) ?? [];
  const posted = (project.posted_channels as string[]) ?? [];
  const parsed = project.approved_content
    ? socialPostsOutputSchema.safeParse(project.approved_content)
    : null;
  const content = parsed?.success ? parsed.data : null;

  const channelText = (channel: ChannelKey): string | null => {
    if (!content) return null;
    switch (channel) {
      case "hp":
        return content.hp ? `${content.hp.title}\n\n${content.hp.body}` : null;
      case "instagram":
        return content.instagram
          ? `${content.instagram.caption}\n\n${content.instagram.hashtags.map((h) => `#${h}`).join(" ")}`
          : null;
      case "facebook":
        return content.facebook?.post_text ?? null;
      case "youtube":
        return content.youtube
          ? `【タイトル】${content.youtube.title}\n\n【概要欄】\n${content.youtube.description}\n\n【タグ】${content.youtube.tags.join(", ")}`
          : null;
    }
  };

  return (
    <>
      <PageHeader
        title={project.title as string}
        description={`一次データ: ${SOURCE_LABELS[project.source_kind as string] ?? project.source_kind}`}
      />
      <div className="space-y-4">
        <Card>
          <CardTitle>一次データ</CardTitle>
          <details>
            <summary className="cursor-pointer text-xs text-stone-500">
              全文を表示（{(project.source_text as string).length}字）
            </summary>
            <p className="mt-1 whitespace-pre-wrap text-sm text-stone-600">
              {project.source_text as string}
            </p>
          </details>
        </Card>

        <Card>
          <CardTitle>投稿文の生成</CardTitle>
          <GenerateSocialButton projectId={id} />
        </Card>

        {content ? (
          <Card>
            <div className="flex items-center justify-between">
              <CardTitle>確定版（チャンネル別）</CardTitle>
              <Badge color={project.status === "posted" ? "green" : "amber"}>
                {project.status === "posted" ? "全チャンネル投稿完了" : "投稿待ちあり"}
              </Badge>
            </div>
            <div className="space-y-3">
              {channels.map((channel) => {
                const text = channelText(channel);
                if (!text) return null;
                return (
                  <ChannelPostBlock
                    key={channel}
                    projectId={id}
                    channel={channel}
                    label={CHANNELS[channel]}
                    text={text}
                    posted={posted.includes(channel)}
                  />
                );
              })}
            </div>
            {content.missing_information.length ? (
              <p className="mt-3 text-xs text-amber-700">
                要確認: {content.missing_information.join(" / ")}
              </p>
            ) : null}
            <p className="mt-3 text-xs text-stone-400">
              現在は「コピー → 各アプリに貼り付け → 投稿済みにする」の運用です。
              Instagram/Facebook/YouTubeへのワンタップ自動投稿は段階2
              （Meta・GoogleのAPI認証の準備が必要。docs/08参照）。
            </p>
          </Card>
        ) : null}
      </div>
    </>
  );
}
