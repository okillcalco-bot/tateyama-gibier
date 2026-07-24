import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";
import { ADVISOR_CATEGORIES, type AdvisorCategory } from "@/ai/schemas/advisor.schema";
import { NewConsultationForm } from "./advisor-forms";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, { label: string; color: "gray" | "blue" | "green" | "amber" }> = {
  open: { label: "整理待ち", color: "gray" },
  approved: { label: "整理済み（専門家へ）", color: "amber" },
  closed: { label: "相談完了", color: "green" },
};

export default async function AdvisorPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="士業相談" />
        <SetupNotice />
      </>
    );
  }
  const supabase = await createSupabaseServerClient();
  const { data: consultations } = await supabase
    .from("advisor_consultations")
    .select("id, category, title, status, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <>
      <PageHeader
        title="士業相談"
        description="税務・労務・法務・知財の困りごとをAIが一次整理。本物の専門家に相談しやすい形にします。"
      />
      <p className="mb-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
        ⚠ AIの整理は一般的な情報であり、法的・税務的な助言ではありません。
        最終判断は必ず資格を持つ専門家（税理士・社労士・弁護士・弁理士など）に確認してください。
      </p>
      <NewConsultationForm />
      <div className="mt-4 space-y-3">
        {!consultations?.length ? (
          <EmptyState message="相談はまだありません。気軽に書いてください。" />
        ) : (
          consultations.map((c) => {
            const status = STATUS_LABELS[c.status] ?? STATUS_LABELS.open;
            return (
              <Link key={c.id} href={`/advisor/${c.id}`} className="block">
                <Card className="hover:border-green-300">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{c.title}</p>
                      <p className="mt-1 text-xs text-stone-400">
                        {ADVISOR_CATEGORIES[c.category as AdvisorCategory] ?? c.category} ・
                        {String(c.created_at).slice(0, 10)}
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
