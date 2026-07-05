import { notFound } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, CardTitle, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";
import { RequirementItem, AddRequirementsForm, GenerateGrantDraftButton } from "../grant-forms";

export const dynamic = "force-dynamic";

/** 補助金案件 詳細: 要件チェックリスト・経費・確定文書・ドラフト生成 */
export default async function GrantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="補助金案件" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data: project } = await supabase
    .from("grant_projects")
    .select(
      `id, name, target_business, status, requested_amount, note,
       grant_opportunities (name, agency, application_deadline),
       grant_requirements (id, requirement_text, category, is_met, evidence_note, sort_order),
       grant_budget_items (id, category, item_name, amount, sort_order),
       grant_documents (id, doc_type, title, version, created_at)`,
    )
    .eq("id", id)
    .maybeSingle();

  if (!project) notFound();

  const opportunity = project.grant_opportunities as unknown as {
    name: string;
    agency: string | null;
    application_deadline: string | null;
  } | null;
  const requirements = (
    (project.grant_requirements ?? []) as {
      id: string;
      requirement_text: string;
      category: string | null;
      is_met: boolean | null;
      evidence_note: string | null;
      sort_order: number | null;
    }[]
  ).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const budgetItems = (
    (project.grant_budget_items ?? []) as {
      id: string;
      category: string;
      item_name: string;
      amount: number;
      sort_order: number | null;
    }[]
  ).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const documents = (project.grant_documents ?? []) as {
    id: string;
    doc_type: string;
    title: string;
    version: number;
    created_at: string;
  }[];
  const met = requirements.filter((r) => r.is_met === true).length;

  return (
    <>
      <PageHeader
        title={project.name}
        description={
          opportunity
            ? `${opportunity.name}（${opportunity.agency ?? ""}）` +
              (opportunity.application_deadline ? ` 締切 ${opportunity.application_deadline}` : "")
            : "公募情報 未紐付け"
        }
      />

      <div className="space-y-4">
        <Card>
          <CardTitle>
            要件チェックリスト（充足 {met}/{requirements.length}）
          </CardTitle>
          {requirements.length ? (
            <ul className="divide-y divide-stone-100">
              {requirements.map((requirement) => (
                <RequirementItem
                  key={requirement.id}
                  requirement={requirement}
                  grantProjectId={id}
                />
              ))}
            </ul>
          ) : (
            <EmptyState message="要件はまだ登録されていません。公募要領から貼り付けてください。" />
          )}
          <AddRequirementsForm grantProjectId={id} />
        </Card>

        <Card>
          <CardTitle>経費計画</CardTitle>
          {budgetItems.length ? (
            <ul className="divide-y divide-stone-100 text-sm">
              {budgetItems.map((item) => (
                <li key={item.id} className="flex justify-between py-2">
                  <span>
                    <Badge color="gray">{item.category}</Badge> {item.item_name}
                  </span>
                  <span>{Number(item.amount).toLocaleString()}円</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-stone-400">経費はまだ登録されていません。</p>
          )}
        </Card>

        <Card>
          <CardTitle>申請書ドラフト</CardTitle>
          <GenerateGrantDraftButton grantProjectId={id} />
          {documents.length ? (
            <div className="mt-3">
              <p className="text-xs font-semibold text-stone-500">確定済み文書（承認済み）</p>
              <ul className="divide-y divide-stone-100 text-sm">
                {documents.map((doc) => (
                  <li key={doc.id} className="flex justify-between py-2">
                    <span>{doc.title}</span>
                    <span className="text-xs text-stone-400">
                      v{doc.version} ・{String(doc.created_at).slice(0, 10)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
