import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, CardTitle, PageHeader, SetupNotice, Badge } from "@/components/ui";
import { advisorOutputSchema, ADVISOR_CATEGORIES, type AdvisorCategory } from "@/ai/schemas/advisor.schema";
import { GenerateAdvisorButton, CopyTextButton, CloseConsultationForm } from "../advisor-forms";

export const dynamic = "force-dynamic";

const URGENCY = {
  low: { label: "急ぎではない", color: "gray" as const },
  medium: { label: "普通", color: "blue" as const },
  high: { label: "急ぎ（期限の可能性）", color: "red" as const },
};

export default async function AdvisorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="士業相談" />
        <SetupNotice />
      </>
    );
  }
  const supabase = await createSupabaseServerClient();
  const { data: consultation } = await supabase
    .from("advisor_consultations")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!consultation) notFound();

  const parsed = consultation.approved_content
    ? advisorOutputSchema.safeParse(consultation.approved_content)
    : null;
  const content = parsed?.success ? parsed.data : null;

  const expertPackage = content
    ? [
        `【相談】${consultation.title}`,
        ``,
        `■ 状況`,
        consultation.question,
        ``,
        `■ 論点（AI一次整理・要確認）`,
        content.issue_summary,
        ``,
        `■ 伺いたいこと`,
        ...content.questions_for_expert.map((q, i) => `${i + 1}. ${q}`),
      ].join("\n")
    : "";

  return (
    <>
      <PageHeader
        title={consultation.title as string}
        description={ADVISOR_CATEGORIES[consultation.category as AdvisorCategory] ?? ""}
      />
      <div className="space-y-4">
        <Card>
          <CardTitle>相談内容</CardTitle>
          <p className="whitespace-pre-wrap text-sm text-stone-700">
            {consultation.question as string}
          </p>
        </Card>

        {consultation.status !== "closed" ? (
          <Card>
            <CardTitle>AIによる一次整理</CardTitle>
            <GenerateAdvisorButton consultationId={id} />
            <p className="mt-1 text-xs text-stone-400">
              結果は承認センターを通ってからこのページに表示されます。
            </p>
          </Card>
        ) : null}

        {content ? (
          <Card>
            <div className="flex items-center justify-between">
              <CardTitle>整理結果</CardTitle>
              <Badge color={URGENCY[content.urgency].color}>{URGENCY[content.urgency].label}</Badge>
            </div>
            {content.urgency_reason ? (
              <p className="mb-2 text-xs text-stone-500">{content.urgency_reason}</p>
            ) : null}

            <p className="text-xs font-semibold text-stone-500">論点</p>
            <p className="mb-2 whitespace-pre-wrap text-sm">{content.issue_summary}</p>

            <p className="text-xs font-semibold text-stone-500">一般的な考え方（一般情報）</p>
            <p className="mb-2 whitespace-pre-wrap text-sm">{content.general_guidance}</p>

            {content.key_facts_needed.length ? (
              <>
                <p className="text-xs font-semibold text-stone-500">確認しておく事実</p>
                <ul className="mb-2 list-disc pl-5 text-sm">
                  {content.key_facts_needed.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {content.documents_to_prepare.length ? (
              <>
                <p className="text-xs font-semibold text-stone-500">準備する書類</p>
                <ul className="mb-2 list-disc pl-5 text-sm">
                  {content.documents_to_prepare.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </>
            ) : null}

            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-semibold text-stone-500">
                専門家（{content.recommended_expert}）への質問リスト
              </p>
              <CopyTextButton text={expertPackage} label="相談文一式をコピー" />
            </div>
            <ol className="mb-2 list-decimal pl-5 text-sm">
              {content.questions_for_expert.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ol>
            {content.missing_information.length ? (
              <p className="text-xs text-amber-700">
                情報不足: {content.missing_information.join(" / ")}
              </p>
            ) : null}
            <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
              ⚠ これは一般的な情報整理であり、法的・税務的助言ではありません。
              「相談文一式をコピー」してLINEやメールでそのまま専門家に送れます。
            </p>
          </Card>
        ) : null}

        {consultation.status === "closed" ? (
          <Card>
            <CardTitle>専門家相談の結果（記録済み）</CardTitle>
            <p className="whitespace-pre-wrap text-sm text-stone-700">
              {(consultation.expert_note as string) || "（メモなし）"}
            </p>
          </Card>
        ) : content ? (
          <Card>
            <CardTitle>専門家に相談したら結果を残す</CardTitle>
            <CloseConsultationForm consultationId={id} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
