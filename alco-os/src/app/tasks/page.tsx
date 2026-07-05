import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageHeader, SetupNotice, EmptyState } from "@/components/ui";
import { TaskItem, type TaskRow } from "./task-item";

export const dynamic = "force-dynamic";

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
  const [{ data: tasks }, { data: recentDone }] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, status, priority, due_date, module")
      .is("deleted_at", null)
      .in("status", ["open", "in_progress"])
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(100),
    supabase
      .from("tasks")
      .select("id, title, updated_at")
      .is("deleted_at", null)
      .eq("status", "done")
      .order("updated_at", { ascending: false })
      .limit(5),
  ]);

  return (
    <>
      <PageHeader title="タスク" description="◯をタップで完了" />
      <div className="space-y-2">
        {!tasks?.length ? (
          <EmptyState message="未処理のタスクはありません。音声メモの承認からタスクが作成されます。" />
        ) : (
          tasks.map((task) => <TaskItem key={task.id} task={task as TaskRow} />)
        )}
      </div>

      {recentDone?.length ? (
        <div className="mt-6">
          <p className="mb-2 text-xs font-semibold text-stone-400">最近完了したタスク</p>
          <ul className="space-y-1">
            {recentDone.map((task) => (
              <li key={task.id} className="text-sm text-stone-400 line-through">
                {task.title}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
