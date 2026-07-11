"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui";
import type { ActionResult } from "@/lib/action-result";
import { CHANNELS, type ChannelKey } from "@/ai/schemas/social.schema";
import {
  createSocialProjectAction,
  generateSocialPostsAction,
  markChannelPostedAction,
} from "./actions";

const inputClass = "w-full rounded-lg border border-stone-300 px-3 py-2 text-sm";
const buttonClass =
  "rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";

function useAction() {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult>, onDone?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone?.();
    });
  };
  return { isPending, error, run };
}

/** 一次データの登録フォーム */
export function NewSocialProjectForm() {
  const { isPending, error, run } = useAction();
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={buttonClass + " w-full"}>
        ＋ 発信のもとネタを登録（メモ・FB投稿・文字起こし）
      </button>
    );
  }
  return (
    <Card>
      <form
        action={(formData) => run(() => createSocialProjectAction(formData), () => setOpen(false))}
        className="space-y-2"
      >
        <input name="title" required placeholder="テーマ（例: 小学校でジビエ出前授業）" className={inputClass} />
        <select name="source_kind" className={inputClass + " max-w-52"}>
          <option value="memo">メモ・走り書き</option>
          <option value="facebook">個人Facebook投稿</option>
          <option value="video">動画の文字起こし</option>
          <option value="audio">音声の文字起こし</option>
        </select>
        <textarea
          name="source_text"
          rows={6}
          required
          placeholder="一次データを貼り付け。AIはここに無い事実を作りません（音声・動画は文字起こしを貼ってください。自動文字起こしは段階2）"
          className={inputClass}
        />
        <div>
          <p className="mb-1 text-xs text-stone-500">投稿先チャンネル</p>
          <div className="flex flex-wrap gap-3 text-sm">
            {(Object.entries(CHANNELS) as [ChannelKey, string][]).map(([key, label]) => (
              <label key={key} className="flex items-center gap-1">
                <input type="checkbox" name="channels" value={key} defaultChecked />
                {label}
              </label>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button type="submit" disabled={isPending} className={buttonClass + " flex-1"}>
            {isPending ? "登録中…" : "登録"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg border border-stone-300 px-4 py-2 text-sm text-stone-600"
          >
            閉じる
          </button>
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </form>
    </Card>
  );
}

export function GenerateSocialButton({ projectId }: { projectId: string }) {
  const { isPending, error, run } = useAction();
  const [done, setDone] = useState(false);
  return (
    <div>
      <button
        onClick={() => run(() => generateSocialPostsAction(projectId), () => setDone(true))}
        disabled={isPending}
        className={buttonClass + " w-full"}
      >
        {isPending ? "AIが各チャンネル向けに書き換え中…" : "各チャンネル向けの投稿文をAI生成"}
      </button>
      {done ? (
        <p className="mt-1 text-sm text-green-700">
          生成しました。承認センター（承認タブ）で内容を確認・承認すると、このページに確定版が出ます。
        </p>
      ) : null}
      {error ? <p className="mt-1 text-sm text-red-600">{error}</p> : null}
      <p className="mt-1 text-xs text-stone-400">
        一次データに無い事実は書かず、不足は「要確認」として列挙します。承認するまで公開されません。
      </p>
    </div>
  );
}

/** 原稿のコピー + 投稿済みマーク */
export function ChannelPostBlock({
  projectId,
  channel,
  label,
  text,
  posted,
}: {
  projectId: string;
  channel: ChannelKey;
  label: string;
  text: string;
  posted: boolean;
}) {
  const { isPending, error, run } = useAction();
  const [copied, setCopied] = useState(false);

  return (
    <div className="rounded-lg border border-stone-200 p-3">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-sm font-semibold">
          {label} {posted ? <span className="text-xs text-green-700">✓ 投稿済み</span> : null}
        </p>
        <div className="flex gap-2">
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="rounded-lg border border-green-700 px-3 py-1 text-xs font-semibold text-green-700"
          >
            {copied ? "コピーしました" : "コピー"}
          </button>
          {!posted ? (
            <button
              onClick={() => run(() => markChannelPostedAction(projectId, channel))}
              disabled={isPending}
              className="rounded-lg bg-green-700 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
            >
              投稿済みにする
            </button>
          ) : null}
        </div>
      </div>
      <pre className="whitespace-pre-wrap rounded bg-stone-50 p-2 text-sm text-stone-700">{text}</pre>
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
