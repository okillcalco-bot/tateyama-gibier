import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, CardTitle, PageHeader, SetupNotice, Badge } from "@/components/ui";
import { GenerateMediaButton } from "../media-forms";
import {
  presentationOutputSchema,
  videoPlanOutputSchema,
} from "@/ai/schemas/media.schema";

export const dynamic = "force-dynamic";

/** メディア案件 詳細: ブリーフ・素材・AI生成・確定版（PPTX / 台本） */
export default async function MediaDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="メディア案件" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const [{ data: project }, { data: assets }] = await Promise.all([
    supabase.from("media_projects").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("files")
      .select("id, filename, mime_type")
      .eq("related_table", "media_projects")
      .eq("related_id", id)
      .is("deleted_at", null),
  ]);

  if (!project) notFound();
  const isVideo = project.kind === "youtube_video";

  return (
    <>
      <PageHeader
        title={project.title}
        description={`${isVideo ? "YouTube動画" : "プレゼン資料"} ・${project.duration_minutes ?? "?"}分${project.target_audience ? ` ・${project.target_audience}` : ""}`}
      />

      <div className="space-y-4">
        <Card>
          <CardTitle>ブリーフ</CardTitle>
          <dl className="space-y-1 text-sm">
            {project.format ? (
              <div>
                <dt className="inline font-medium">型: </dt>
                <dd className="inline text-stone-600">{project.format}</dd>
              </div>
            ) : null}
            {project.key_messages ? (
              <div>
                <dt className="font-medium">伝えたいこと:</dt>
                <dd className="whitespace-pre-wrap text-stone-600">{project.key_messages}</dd>
              </div>
            ) : null}
          </dl>
          {assets?.length ? (
            <p className="mt-2 text-xs text-stone-400">
              素材: {assets.map((a) => a.filename).join(" / ")}
            </p>
          ) : (
            <p className="mt-2 text-xs text-stone-400">素材なし</p>
          )}
        </Card>

        <Card>
          <CardTitle>{isVideo ? "台本・メタデータ" : "構成・原稿"}</CardTitle>
          <GenerateMediaButton projectId={id} kind={project.kind} />
        </Card>

        {project.approved_content ? (
          isVideo ? (
            <VideoPlanView content={project.approved_content} />
          ) : (
            <PresentationView content={project.approved_content} projectId={id} />
          )
        ) : null}
      </div>
    </>
  );
}

/** 確定済みプレゼン構成の表示 + PPTXダウンロード */
function PresentationView({ content, projectId }: { content: unknown; projectId: string }) {
  const parsed = presentationOutputSchema.safeParse(content);
  if (!parsed.success) return null;
  const plan = parsed.data;

  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardTitle>確定版: {plan.title}</CardTitle>
        <Badge color="green">構成確定</Badge>
      </div>
      <a
        href={`/api/media/${projectId}/pptx`}
        className="mb-3 block rounded-lg bg-green-700 px-4 py-2 text-center text-sm font-semibold text-white"
      >
        ⬇ PowerPoint（.pptx）をダウンロード
      </a>
      <ol className="space-y-3">
        {plan.slides.map((slide, i) => (
          <li key={i} className="rounded-lg bg-stone-50 p-3">
            <p className="text-sm font-semibold">
              {i + 1}. {slide.title}
              <span className="ml-2 text-xs font-normal text-stone-400">{slide.minutes}分</span>
              {slide.photo_filename ? (
                <span className="ml-2 text-xs font-normal text-stone-400">📷 {slide.photo_filename}</span>
              ) : null}
            </p>
            <ul className="mt-1 list-disc pl-5 text-sm text-stone-600">
              {slide.bullets.map((bullet, j) => (
                <li key={j}>{bullet}</li>
              ))}
            </ul>
            {slide.speaker_notes ? (
              <p className="mt-1 text-xs text-stone-500">🎙 {slide.speaker_notes}</p>
            ) : null}
          </li>
        ))}
      </ol>
      {plan.missing_information.length ? (
        <p className="mt-3 text-xs text-amber-700">要確認: {plan.missing_information.join(" / ")}</p>
      ) : null}
    </Card>
  );
}

/** 確定済み動画プランの表示 */
function VideoPlanView({ content }: { content: unknown }) {
  const parsed = videoPlanOutputSchema.safeParse(content);
  if (!parsed.success) return null;
  const plan = parsed.data;

  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardTitle>確定版: 動画プラン</CardTitle>
        <Badge color="green">構成確定</Badge>
      </div>

      <p className="text-xs font-semibold text-stone-500">タイトル案</p>
      <ol className="mb-2 list-decimal pl-5 text-sm">
        {plan.title_candidates.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ol>

      <p className="text-xs font-semibold text-stone-500">台本</p>
      <ol className="mb-2 space-y-2">
        {plan.script.map((cut, i) => (
          <li key={i} className="rounded-lg bg-stone-50 p-3 text-sm">
            <p className="font-semibold">
              {cut.section}
              <span className="ml-2 text-xs font-normal text-stone-400">{cut.seconds}秒</span>
              {cut.asset_filename ? (
                <span className="ml-2 text-xs font-normal text-stone-400">🎞 {cut.asset_filename}</span>
              ) : null}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-stone-700">{cut.narration}</p>
            {cut.visual ? <p className="mt-1 text-xs text-stone-500">🎬 {cut.visual}</p> : null}
          </li>
        ))}
      </ol>

      <details className="mb-2 rounded-lg bg-stone-50 p-2 text-sm">
        <summary className="cursor-pointer text-xs font-semibold text-stone-500">
          概要欄・タグ・チャプター（コピー用）
        </summary>
        <pre className="mt-1 whitespace-pre-wrap text-xs text-stone-700">
          {plan.description}
          {"\n\n"}
          {plan.chapters.map((c) => `${c.time} ${c.label}`).join("\n")}
          {"\n\n"}
          {plan.tags.map((t) => `#${t}`).join(" ")}
        </pre>
      </details>

      {plan.thumbnail_text.length ? (
        <p className="text-sm">
          <span className="text-xs font-semibold text-stone-500">サムネ文言案: </span>
          {plan.thumbnail_text.join(" ／ ")}
        </p>
      ) : null}
      {plan.cta ? (
        <p className="text-sm">
          <span className="text-xs font-semibold text-stone-500">CTA: </span>
          {plan.cta}
        </p>
      ) : null}
      {plan.missing_information.length ? (
        <p className="mt-2 text-xs text-amber-700">
          不足素材・要撮影: {plan.missing_information.join(" / ")}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-stone-400">
        動画の自動レンダリング・YouTube自動アップロードは段階2で追加予定
        （この台本・メタデータのデータ構造はそのまま使えます）。
      </p>
    </Card>
  );
}
