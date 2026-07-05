"use client";

import { useTransition, useState } from "react";
import { createAndClassifyMemo } from "./actions";
import { Card } from "@/components/ui";

/** モバイル最優先のメモ入力フォーム */
export function MemoForm() {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Card>
      <form
        action={(formData) => {
          setError(null);
          startTransition(async () => {
            const result = await createAndClassifyMemo(formData);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            (document.getElementById("memo-form") as HTMLFormElement | null)?.reset();
          });
        }}
        id="memo-form"
        className="space-y-3"
      >
        <input
          name="title"
          placeholder="タイトル（任意）"
          className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
        />
        <textarea
          name="raw_text"
          required
          rows={4}
          placeholder="音声文字起こし・現場メモを貼り付け"
          className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
        />
        <div className="flex items-center gap-2">
          <select
            name="source_type"
            className="rounded-lg border border-stone-300 px-3 py-2 text-sm"
            defaultValue="voice_transcript"
          >
            <option value="voice_transcript">音声文字起こし</option>
            <option value="text_memo">テキストメモ</option>
            <option value="meeting_note">会議メモ</option>
            <option value="field_note">現場メモ</option>
          </select>
          <button
            type="submit"
            disabled={isPending}
            className="flex-1 rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {isPending ? "AI分類中…" : "登録してAI分類"}
          </button>
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <p className="text-xs text-stone-400">
          AIの分類結果はドラフトとして保存され、承認するまでタスク等には反映されません。
        </p>
      </form>
    </Card>
  );
}
