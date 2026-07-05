import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";
import { DraftActions } from "./draft-actions";

export const dynamic = "force-dynamic";

const DRAFT_TYPE_LABELS: Record<string, string> = {
  voice_memo_result: "メモ分類",
  grant_application: "補助金申請書",
  nature_report: "自然資本レポート",
  meeting_minutes: "議事録",
};

/**
 * 承認センター。
 * すべてのAI生成物はここで人間が承認・修正・破棄する。
 * 承認されるまで業務データには一切反映されない（ALCO OS の中核ルール）。
 */
export default async function DraftsPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="承認待ちドラフト" description="AI生成物のレビューと承認" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data: drafts } = await supabase
    .from("generated_drafts")
    .select("id, draft_type, title, content, confidence, warnings, status, created_at")
    .eq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <>
      <PageHeader title="承認待ちドラフト" description="AI生成物のレビューと承認" />
      <div className="space-y-3">
        {!drafts?.length ? (
          <EmptyState message="承認待ちのドラフトはありません。" />
        ) : (
          drafts.map((draft) => {
            const content = draft.content as Record<string, unknown>;
            const suggestedTasks = Array.isArray(content?.suggested_tasks)
              ? (content.suggested_tasks as { title: string; due_date: string | null }[])
              : [];
            return (
              <Card key={draft.id}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{draft.title ?? "（無題ドラフト）"}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge color="blue">
                        {DRAFT_TYPE_LABELS[draft.draft_type] ?? draft.draft_type}
                      </Badge>
                      {typeof draft.confidence === "number" ? (
                        <Badge color={draft.confidence >= 0.8 ? "green" : "amber"}>
                          確信度 {Math.round(draft.confidence * 100)}%
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </div>

                {typeof content?.summary === "string" ? (
                  <p className="mt-2 text-sm text-stone-600">{content.summary}</p>
                ) : null}

                {typeof content?.draft_text === "string" ||
                typeof content?.draft_proposal_text === "string" ? (
                  <details className="mt-2 rounded-lg bg-stone-50 p-2 text-sm">
                    <summary className="cursor-pointer text-xs font-semibold text-stone-500">
                      本文プレビュー
                    </summary>
                    <p className="mt-1 whitespace-pre-wrap text-stone-700">
                      {String(content.draft_text ?? content.draft_proposal_text)}
                    </p>
                  </details>
                ) : null}

                {Array.isArray(content?.missing_information) &&
                content.missing_information.length > 0 ? (
                  <p className="mt-2 text-xs text-amber-700">
                    要確認: {(content.missing_information as string[]).join(" / ")}
                  </p>
                ) : null}
                {Array.isArray(content?.missing_evidence) && content.missing_evidence.length > 0 ? (
                  <p className="mt-2 text-xs text-amber-700">
                    証跡不足: {(content.missing_evidence as string[]).join(" / ")}
                  </p>
                ) : null}

                {suggestedTasks.length > 0 ? (
                  <div className="mt-2 rounded-lg bg-stone-50 p-2">
                    <p className="text-xs font-semibold text-stone-500">承認で作成されるタスク</p>
                    <ul className="mt-1 list-disc pl-5 text-sm">
                      {suggestedTasks.map((task, i) => (
                        <li key={i}>
                          {task.title}
                          {task.due_date ? (
                            <span className="text-xs text-stone-400">（期限 {task.due_date}）</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {Array.isArray(draft.warnings) && draft.warnings.length > 0 ? (
                  <p className="mt-2 text-xs text-amber-700">⚠ {draft.warnings.join(" / ")}</p>
                ) : null}

                <DraftActions draftId={draft.id} />
              </Card>
            );
          })
        )}
      </div>
    </>
  );
}
