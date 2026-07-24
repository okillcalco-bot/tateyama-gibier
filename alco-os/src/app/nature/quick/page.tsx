import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser, canApprove } from "@/lib/auth";
import { Card, CardTitle, PageHeader, SetupNotice, Badge } from "@/components/ui";
import { maskObservationPoint, effectiveSensitivity } from "@/domain/satoyama/geo-masking";
import {
  QuickObservationForm,
  FieldNoteForm,
  ReviewButtons,
  NewTaxonForm,
} from "./quick-forms";

export const dynamic = "force-dynamic";

/**
 * かんたん投稿（里山OS S02）+ レビュー（S08）。
 * 現場でスマホから3タップ以内に記録できることを最優先にする。
 * 座標は maskObservationPoint を通してから表示する（原座標を画面に出さない）。
 */

type Row = Record<string, unknown>;

const REVIEW_LABELS: Record<string, { label: string; color: "gray" | "green" | "amber" | "red" }> = {
  pending: { label: "レビュー待ち", color: "amber" },
  approved: { label: "承認済み", color: "green" },
  rejected: { label: "差し戻し", color: "red" },
  disputed: { label: "異議あり", color: "amber" },
};

export default async function QuickObservationPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="かんたん投稿" />
        <SetupNotice />
      </>
    );
  }
  const supabase = await createSupabaseServerClient();
  await getCurrentUser(supabase);

  const [{ data: sites }, { data: taxa }, { data: recent }, canReview] = await Promise.all([
    supabase.from("sites").select("id, name").is("deleted_at", null).order("name"),
    supabase
      .from("taxa")
      .select("id, common_name, taxon_group, sensitivity")
      .is("deleted_at", null)
      .order("taxon_group")
      .order("common_name")
      .limit(500),
    supabase
      .from("biodiversity_observations")
      .select(
        "id, species_name, taxon_group, observed_at, lat, lng, sensitivity, review_status, confidence_grade, evidence_type, visibility_level, taxa(sensitivity)",
      )
      .order("created_at", { ascending: false })
      .limit(20),
    canApprove(supabase), // 承認・原座標の閲覧は owner / manager のみ
  ]);

  return (
    <>
      <PageHeader
        title="かんたん投稿"
        description="現場で写真・位置・種だけを記録。あとから証拠とレビューを足していきます。"
      />
      <div className="space-y-4">
        <QuickObservationForm
          sites={((sites ?? []) as Row[]).map((s) => ({
            id: s.id as string,
            name: s.name as string,
          }))}
          taxa={((taxa ?? []) as Row[]).map((t) => ({
            id: t.id as string,
            name: t.common_name as string,
            group: (t.taxon_group as string) ?? "",
            sensitivity: (t.sensitivity as string) ?? "normal",
          }))}
        />

        <Card>
          <CardTitle>現場メモをAIで整理する</CardTitle>
          <p className="mb-2 text-xs text-stone-500">
            音声の文字起こしや走り書きから、種・数量・環境の候補を作ります（確定はしません）。
          </p>
          <FieldNoteForm
            sites={((sites ?? []) as Row[]).map((s) => ({
              id: s.id as string,
              name: s.name as string,
            }))}
          />
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <CardTitle>最近の記録</CardTitle>
            <Link href="/nature/gaps" className="text-xs text-green-700 underline">
              調査ギャップを見る →
            </Link>
          </div>
          {(recent ?? []).length ? (
            <ul className="divide-y divide-stone-100 text-sm">
              {((recent ?? []) as Row[]).map((o) => {
                const taxonSensitivity = (o.taxa as Row | null)?.sensitivity as string | undefined;
                const sensitivity = effectiveSensitivity(
                  o.sensitivity as string,
                  taxonSensitivity,
                );
                // 画面表示は必ずマスク済みの座標を使う
                const point = maskObservationPoint(
                  { lat: Number(o.lat) || null, lng: Number(o.lng) || null, sensitivity },
                  canReview ? "restricted" : "members",
                );
                const review = REVIEW_LABELS[o.review_status as string] ?? REVIEW_LABELS.pending;
                return (
                  <li key={o.id as string} className="flex flex-wrap items-center gap-2 py-2">
                    <Badge color={review.color}>{review.label}</Badge>
                    <span className="font-medium">{o.species_name as string}</span>
                    <span className="text-xs text-stone-400">
                      {String(o.observed_at).slice(0, 10)}
                      {o.confidence_grade ? ` ・証拠${o.confidence_grade}` : ""}
                      {sensitivity !== "normal" ? " ・⚠️保護対象" : ""}
                    </span>
                    <span className="text-xs text-stone-400">
                      {point.hidden
                        ? "📍非公開"
                        : point.lat !== null
                          ? `📍${point.lat.toFixed(3)}, ${point.lng?.toFixed(3)}（${point.precisionLabel}）`
                          : "📍なし"}
                    </span>
                    {canReview && o.review_status === "pending" ? (
                      <ReviewButtons observationId={o.id as string} />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-stone-400">まだ記録がありません。</p>
          )}
        </Card>

        <Card>
          <CardTitle>種マスタ</CardTitle>
          <p className="mb-2 text-xs text-stone-500">
            よく記録する種を登録しておくと投稿が速くなります。希少度をここで設定します（
            {(taxa ?? []).length}件登録済み）。
          </p>
          <NewTaxonForm />
        </Card>
      </div>
    </>
  );
}
