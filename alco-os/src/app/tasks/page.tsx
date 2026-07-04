import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Card, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";

export const dynamic = "force-dynamic";

const PRIORITY_COLOR = { urgent: "red", high: "amber", normal: "gray", low: "gray" } as const;
const STATUS_LABELS: Record<string, string> = {
  open: "未着手",
  in_progress: "対応中",
  done: "完了",
  cancelled: "中止",
};

export default async function TasksPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="タスク" description="全モジュール横断のタスク一覧" />
        <SetupNotice />
      </>
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data: tasks } = await supabase
    .from("tasks")
    .select("id, title, status, priority, due_date, module, created_at")
    .is("deleted_at", null)
    .in("status", ["open", "in_progress"])
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(100);

  return (
    <>
      <PageHeader title="タスク" description="全モジュール横断のタスク一覧" />
      <div className="space-y-2">
        {!tasks?.length ? (
          <EmptyState message="未処理のタスクはありません。音声メモの承認からタスクが作成されます。" />
        ) : (
          tasks.map((task) => (
            <Card key={task.id} className="flex items-center justify-between gap-2 py-3">
              <div>
                <p className="text-sm font-medium">{task.title}</p>
                <p className="text-xs text-stone-400">
                  {STATUS_LABELS[task.status] ?? task.status}
                  {task.due_date ? ` ・期限 ${task.due_date}` : ""}
                  {task.module ? ` ・${task.module}` : ""}
                </p>
              </div>
              <Badge
                color={PRIORITY_COLOR[task.priority as keyof typeof PRIORITY_COLOR] ?? "gray"}
              >
                {task.priority}
              </Badge>
            </Card>
          ))
        )}
      </div>
    </>
  );
}
