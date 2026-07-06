"use client";

import { useTransition, useState } from "react";
import { createMediaProject, generateMediaPlanAction } from "./actions";
import { Card } from "@/components/ui";
import type { ActionResult } from "@/lib/action-result";

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

const inputClass = "w-full rounded-lg border border-stone-300 px-3 py-2 text-sm";
const buttonClass =
  "rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";

/** メディア案件の新規登録フォーム（プレゼン / YouTube動画 共通ブリーフ） */
export function NewMediaForm() {
  const { isPending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("presentation");

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={buttonClass + " w-full"}>
        ＋ プレゼン / 動画を企画する
      </button>
    );
  }
  return (
    <Card>
      <form
        action={(formData) =>
          run(
            () => createMediaProject(formData),
            () => setOpen(false),
          )
        }
        className="space-y-3"
      >
        <select
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className={inputClass}
        >
          <option value="presentation">プレゼン資料（PPTX出力）</option>
          <option value="youtube_video">YouTube動画（台本・メタデータ）</option>
        </select>
        <input
          name="title"
          required
          placeholder="案件名（例: ◯◯商工会 講演 / ジビエ密着動画）"
          className={inputClass}
        />
        <div className="flex gap-2">
          <input
            name="target_audience"
            placeholder={kind === "presentation" ? "聴講者（例: 行政職員）" : "ターゲット視聴者"}
            className={inputClass}
          />
          <input
            name="duration_minutes"
            type="number"
            min="1"
            defaultValue={15}
            placeholder="分"
            className={inputClass + " max-w-20"}
          />
        </div>
        <input
          name="format"
          placeholder={
            kind === "presentation"
              ? "フォーマット（講演 / セミナー / 営業提案 / 行政説明）"
              : "動画の型（密着 / 解説 / Vlog / 施設紹介）"
          }
          className={inputClass}
        />
        <textarea
          name="key_messages"
          rows={2}
          placeholder="聴講者・視聴者に思ってもらいたいこと、持ち帰ってほしい気づき"
          className={inputClass}
        />
        <textarea
          name="source_material"
          rows={4}
          placeholder="まとめたい資料を貼り付け（実績・数字・エピソード等。AIはここに無い事実を作りません）"
          className={inputClass}
        />
        <div>
          <p className="mb-1 text-xs text-stone-500">
            {kind === "presentation" ? "使いたい写真（複数可）" : "素材の写真・動画（複数可）"}
          </p>
          <input name="photos" type="file" accept="image/*,video/*" multiple className="text-sm" />
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

/** AI生成ボタン（構成 / 台本 → 承認待ちドラフト） */
export function GenerateMediaButton({ projectId, kind }: { projectId: string; kind: string }) {
  const { isPending, error, run } = useAction();
  const [done, setDone] = useState(false);
  const label = kind === "youtube_video" ? "台本・メタデータをAI生成" : "プレゼン構成をAI生成";

  return (
    <div>
      <button
        onClick={() =>
          run(
            () => generateMediaPlanAction(projectId),
            () => setDone(true),
          )
        }
        disabled={isPending}
        className={buttonClass + " w-full"}
      >
        {isPending ? "AIが生成中…（30秒ほどかかります）" : label}
      </button>
      {done ? (
        <p className="mt-1 text-sm text-green-700">
          生成しました。承認センター（承認タブ）でレビュー・承認するとこのページに確定版が表示されます。
        </p>
      ) : null}
      {error ? <p className="mt-1 text-sm text-red-600">{error}</p> : null}
      <p className="mt-1 text-xs text-stone-400">
        「まとめたい資料」に無い事実・数字は生成せず【要確認】と明示します。
        写真の割付は添付したファイルのみ（実在チェック付き）。
      </p>
    </div>
  );
}
