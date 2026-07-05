import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";
import { MemoForm } from "./memo-form";

export const dynamic = "force-dynamic";

const CATEGORY_LABELS: Record<string, string> = {
  task: "タスク",
  meeting_minutes: "議事録",
  grant_material: "補助金素材",
  nature_record: "自然記録",
  gibier_operation: "ジビエ業務",
  crm_follow_up: "営業フォロー",
  roka_project: "ROKA",
  idea: "アイデア",
  personal_reminder: "リマインダー",
  unclear: "要確認",
};

const STATUS_LABELS: Record<string, { label: string; color: "gray" | "blue" | "green" }> = {
  new: { label: "未処理", color: "gray" },
  classified: { label: "分類済（承認待ち）", color: "blue" },
  processed: { label: "反映済", color: "green" },
  archived: { label: "アーカイブ", color: "gray" },
};

export default async function MemosPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="音声メモ" description="現場メモ・音声文字起こしを業務文書へ変換" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data: memos } = await supabase
    .from("voice_memos")
    .select("id, title, raw_text, source_type, detected_category, status, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <>
      <PageHeader title="音声メモ" description="現場メモ・音声文字起こしを業務文書へ変換" />
      <MemoForm />
      <div className="mt-4 space-y-3">
        {!memos?.length ? (
          <EmptyState message="メモはまだありません。上のフォームから最初のメモを登録してください。" />
        ) : (
          memos.map((memo) => {
            const status = STATUS_LABELS[memo.status] ?? STATUS_LABELS.new;
            return (
              <Card key={memo.id}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{memo.title ?? "（無題メモ）"}</p>
                    <p className="mt-1 line-clamp-2 text-sm text-stone-500">{memo.raw_text}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge color={status.color}>{status.label}</Badge>
                    {memo.detected_category ? (
                      <Badge color="amber">
                        {CATEGORY_LABELS[memo.detected_category] ?? memo.detected_category}
                      </Badge>
                    ) : null}
                  </div>
                </div>
              </Card>
            );
          })
        )}
      </div>
    </>
  );
}
