"use client";

import { useTransition, useState } from "react";
import { setTaskStatusAction } from "./actions";
import { Card, Badge } from "@/components/ui";

const PRIORITY_COLOR = { urgent: "red", high: "amber", normal: "gray", low: "gray" } as const;

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  module: string | null;
}

/** タスク1件。タップで 完了 / 対応中 に切り替えられる。 */
export function TaskItem({ task }: { task: TaskRow }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const setStatus = (status: "open" | "in_progress" | "done") => {
    setError(null);
    startTransition(async () => {
      const result = await setTaskStatusAction(task.id, status);
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <Card className="py-3">
      <div className="flex items-center gap-3">
        {/* 完了チェックボタン */}
        <button
          onClick={() => setStatus("done")}
          disabled={isPending}
          title="完了にする"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-stone-300 text-transparent transition hover:border-green-600 hover:text-green-600 disabled:opacity-50"
        >
          ✓
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{task.title}</p>
          <p className="text-xs text-stone-400">
            {task.status === "in_progress" ? "対応中" : "未着手"}
            {task.due_date ? ` ・期限 ${task.due_date}` : ""}
            {task.module ? ` ・${task.module}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge color={PRIORITY_COLOR[task.priority as keyof typeof PRIORITY_COLOR] ?? "gray"}>
            {task.priority}
          </Badge>
          {task.status === "open" ? (
            <button
              onClick={() => setStatus("in_progress")}
              disabled={isPending}
              className="text-xs text-stone-400 underline disabled:opacity-50"
            >
              着手する
            </button>
          ) : (
            <button
              onClick={() => setStatus("open")}
              disabled={isPending}
              className="text-xs text-stone-400 underline disabled:opacity-50"
            >
              未着手に戻す
            </button>
          )}
        </div>
      </div>
      {error ? <p className="mt-1 text-sm text-red-600">{error}</p> : null}
    </Card>
  );
}
