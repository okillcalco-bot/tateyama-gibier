import Link from "next/link";
import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser, canApprove } from "@/lib/auth";
import { Card, PageHeader, SetupNotice, EmptyState } from "@/components/ui";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { loadChannelSpecs } from "@/domain/social/crosspost/generation-service";
import {
  DRAFT_STATUS_LABELS,
  DRAFT_STATUS_MARKS,
  type DraftStatus,
} from "@/domain/social/crosspost/channels";
import { resolveFinalBody } from "@/domain/social/crosspost/draft-service";
import { ChannelDraftForm, GenerateButton } from "../crosspost-forms";

export const dynamic = "force-dynamic";

/**
 * ③元投稿詳細 ＋ ④媒体別下書き比較 ＋ ⑦投稿履歴。
 *
 * 375px幅で横スクロールしないよう、媒体は**縦に並べる**。
 * 状態は色だけでなく記号（●！✎✓✔✕⚠）と文字で示す。
 */
interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CrosspostDetailPage({ params }: PageProps) {
  const { id } = await params;

  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="元投稿" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) {
    return (
      <>
        <PageHeader title="元投稿" />
        <Card>
          <p className="text-base">ログインが必要です。</p>
        </Card>
      </>
    );
  }
  const approver = await canApprove(supabase);

  const { data: source } = await supabase
    .from("social_sources")
    .select("id, title, source_no, body, posted_on, category, visibility, note, status, fact_sheet")
    .eq("id", id)
    .maybeSingle();
  if (!source) notFound();

  const [{ data: drafts }, { data: publications }, specs] = await Promise.all([
    supabase
      .from("social_channel_drafts")
      .select(
        "id, channel_key, ai_body, edited_body, approved_body, status, review_reasons, reject_reason, char_count, hashtags, cta, cautions, anonymized_notes, error_message, style_version",
      )
      .eq("social_source_id", id),
    supabase
      .from("social_publications")
      .select("id, channel_key, posted_url, posted_at, result, error_message, created_at")
      .eq("social_source_id", id)
      .order("created_at", { ascending: false }),
    loadChannelSpecs(new SupabaseDb(supabase), user.organizationId, { onlyEnabled: false }),
  ]);

  const draftByChannel = new Map(
    (drafts ?? []).map((d) => [String(d.channel_key), d as Record<string, unknown>]),
  );
  const enabledSpecs = specs.filter((s) => s.enabled);

  return (
    <>
      <PageHeader
        title={source.title || "元投稿"}
        description="下書きは公開されません。媒体ごとに確認して承認してください。"
      />

      <div className="space-y-5">
        {/* ③ 元投稿 */}
        <Card>
          <p className="text-sm text-stone-500">
            {source.posted_on ?? "投稿日なし"}
            {source.source_no ? ` ／ #${source.source_no}` : ""}
            {source.category ? ` ／ ${source.category}` : ""}
            {source.visibility ? ` ／ ${source.visibility}` : ""}
          </p>
          <p className="mt-2 whitespace-pre-wrap break-words text-base text-stone-800">
            {source.body}
          </p>
          {source.note ? (
            <p className="mt-2 rounded-xl bg-stone-50 p-3 text-base text-stone-700">
              メモ：{source.note}
            </p>
          ) : null}
          <GenerateButton
            sourceId={id}
            label={drafts?.length ? "↻ すべての媒体を作り直す" : "▶ 媒体別の下書きを作る"}
          />
        </Card>

        {/* ④ 媒体別の比較 */}
        <section>
          <h2 className="mb-2 text-lg font-bold text-stone-800">媒体別の下書き</h2>
          {enabledSpecs.length === 0 ? (
            <EmptyState message="有効な媒体がありません。設定画面で媒体を有効にしてください。" />
          ) : (
            <div className="space-y-3">
              {enabledSpecs.map((spec) => {
                const draft = draftByChannel.get(spec.key);
                const status = (draft?.status as DraftStatus) ?? "not_generated";
                const reasons = Array.isArray(draft?.review_reasons)
                  ? (draft?.review_reasons as string[])
                  : [];
                const body = draft
                  ? (draft.approved_body as string) ||
                    resolveFinalBody(draft as Record<string, unknown>)
                  : "";

                return (
                  <Card key={spec.key}>
                    <details>
                      <summary className="cursor-pointer list-none">
                        <span className="text-base font-bold text-stone-800">
                          <span aria-hidden="true">{DRAFT_STATUS_MARKS[status]}</span> {spec.label}
                          ：{DRAFT_STATUS_LABELS[status]}
                        </span>
                        <span className="mt-1 block break-words text-base text-stone-600">
                          {body ? `${body.slice(0, 60)}…` : "まだ下書きがありません"}
                        </span>
                        {draft?.char_count ? (
                          <span className="mt-1 block text-sm text-stone-500">
                            {String(draft.char_count)}字
                            {spec.maxChars ? ` / 目安 ${spec.maxChars}字` : ""}
                            {draft.style_version ? ` ／ スタイル v${String(draft.style_version)}` : ""}
                          </span>
                        ) : null}
                      </summary>

                      {draft?.error_message ? (
                        <p className="mt-2 rounded-xl bg-red-50 p-3 text-base font-bold text-red-700">
                          ⚠ {String(draft.error_message)}
                        </p>
                      ) : null}
                      {draft?.reject_reason ? (
                        <p className="mt-2 rounded-xl bg-stone-100 p-3 text-base text-stone-700">
                          却下の理由：{String(draft.reject_reason)}
                        </p>
                      ) : null}
                      {Array.isArray(draft?.anonymized_notes) &&
                      (draft?.anonymized_notes as string[]).length > 0 ? (
                        <p className="mt-2 rounded-xl bg-stone-50 p-3 text-base text-stone-700">
                          伏せた箇所：{(draft?.anonymized_notes as string[]).join(" / ")}
                        </p>
                      ) : null}

                      {draft ? (
                        <ChannelDraftForm
                          sourceId={id}
                          draftId={String(draft.id)}
                          body={body}
                          reviewReasons={reasons}
                          status={String(status)}
                          canApprove={approver}
                        />
                      ) : null}

                      <GenerateButton
                        sourceId={id}
                        channelKey={spec.key}
                        label={draft ? "↻ この媒体だけ作り直す" : "▶ この媒体の下書きを作る"}
                      />
                    </details>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        {/* ⑦ 投稿履歴 */}
        <section>
          <h2 className="mb-2 text-lg font-bold text-stone-800">投稿履歴</h2>
          {!publications?.length ? (
            <EmptyState message="まだ投稿の記録はありません。" />
          ) : (
            <div className="space-y-3">
              {publications.map((pub) => (
                <Card key={pub.id}>
                  <p className="text-base font-bold text-stone-800">
                    <span aria-hidden="true">{pub.result === "success" ? "✔" : "⚠"}</span>{" "}
                    {pub.channel_key}
                    ：{pub.result === "success" ? "投稿済み" : "失敗"}
                  </p>
                  {pub.posted_url ? (
                    <p className="mt-1 break-all text-base text-stone-700">{pub.posted_url}</p>
                  ) : null}
                  {pub.error_message ? (
                    <p className="mt-1 text-base text-red-700">{pub.error_message}</p>
                  ) : null}
                </Card>
              ))}
            </div>
          )}
        </section>

        <Link
          href="/crosspost"
          className="flex min-h-[56px] w-full items-center justify-center rounded-xl border-2 border-stone-400 px-4 text-base font-bold text-stone-700"
        >
          ← 一覧へもどる
        </Link>
      </div>
    </>
  );
}
