"use client";

import { useTransition, useState } from "react";
import { approveDraftAction, discardDraftAction } from "@/app/memos/actions";

export function DraftActions({ draftId }: { draftId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: (id: string) => Promise<void>) => {
    setError(null);
    startTransition(async () => {
      try {
        await fn(draftId);
      } catch (e) {
        setError(e instanceof Error ? e.message : "エラーが発生しました");
      }
    });
  };

  return (
    <div className="mt-3">
      <div className="flex gap-2">
        <button
          onClick={() => run(approveDraftAction)}
          disabled={isPending}
          className="flex-1 rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          承認して反映
        </button>
        <button
          onClick={() => run(discardDraftAction)}
          disabled={isPending}
          className="rounded-lg border border-stone-300 px-4 py-2 text-sm text-stone-600 disabled:opacity-50"
        >
          破棄
        </button>
      </div>
      {error ? <p className="mt-1 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
