"use client";

import { useTransition, useState } from "react";
import { classifyMemoAction } from "./actions";

/** 未処理メモの「AI分類を実行」ボタン */
export function ReclassifyButton({ memoId }: { memoId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-2">
      <button
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await classifyMemoAction(memoId);
            if (!result.ok) setError(result.error);
          });
        }}
        disabled={isPending}
        className="rounded-lg border border-green-700 px-3 py-1.5 text-sm font-semibold text-green-700 disabled:opacity-50"
      >
        {isPending ? "AI分類中…" : "AI分類を実行"}
      </button>
      {error ? <p className="mt-1 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
