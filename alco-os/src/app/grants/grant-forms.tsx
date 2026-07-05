"use client";

import { useTransition, useState } from "react";
import {
  createGrantProject,
  addRequirements,
  setRequirementMet,
  generateGrantDraftAction,
} from "./actions";
import { Card } from "@/components/ui";
import type { ActionResult } from "@/lib/action-result";

/** server action 実行の共通フック（エラー表示付き） */
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

/** 補助金案件の新規登録フォーム */
export function NewGrantForm() {
  const { isPending, error, run } = useAction();
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={buttonClass + " w-full"}>
        ＋ 補助金案件を登録
      </button>
    );
  }
  return (
    <Card>
      <form
        id="new-grant-form"
        action={(formData) =>
          run(
            () => createGrantProject(formData),
            () => setOpen(false),
          )
        }
        className="space-y-3"
      >
        <input name="name" required placeholder="案件名（例: ○○補助金 R.O.K.A.改修）" className={inputClass} />
        <div className="flex gap-2">
          <select name="target_business" className={inputClass} defaultValue="">
            <option value="">対象事業を選択</option>
            <option value="gibier">ジビエ</option>
            <option value="roka">R.O.K.A.</option>
            <option value="nature">自然共生・里山</option>
            <option value="other">その他</option>
          </select>
          <input
            name="requested_amount"
            type="number"
            placeholder="申請予定額（円）"
            className={inputClass}
          />
        </div>
        <textarea name="note" rows={2} placeholder="メモ（事業概要・狙いなど）" className={inputClass} />
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

/** 要件チェックリスト行（null → ✅ → ❌ → null のトグル） */
export function RequirementItem({
  requirement,
  grantProjectId,
}: {
  requirement: { id: string; requirement_text: string; is_met: boolean | null; evidence_note: string | null };
  grantProjectId: string;
}) {
  const { isPending, run } = useAction();
  const next = requirement.is_met === null ? true : requirement.is_met ? false : null;
  const icon = requirement.is_met === null ? "⬜" : requirement.is_met ? "✅" : "❌";

  return (
    <li className="flex items-start gap-2 py-2">
      <button
        onClick={() => run(() => setRequirementMet(requirement.id, grantProjectId, next))}
        disabled={isPending}
        className="text-lg leading-none disabled:opacity-50"
        title="タップで 未確認 → 充足 → 未充足 を切替"
      >
        {icon}
      </button>
      <div>
        <p className="text-sm">{requirement.requirement_text}</p>
        {requirement.evidence_note ? (
          <p className="text-xs text-stone-400">根拠: {requirement.evidence_note}</p>
        ) : null}
      </div>
    </li>
  );
}

/** 要件の一括追加フォーム */
export function AddRequirementsForm({ grantProjectId }: { grantProjectId: string }) {
  const { isPending, error, run } = useAction();
  return (
    <form
      action={(formData) =>
        run(
          () => addRequirements(grantProjectId, formData),
          () => {
            const textarea = document.getElementById("req-textarea") as HTMLTextAreaElement | null;
            if (textarea) textarea.value = "";
          },
        )
      }
      className="mt-2 space-y-2"
    >
      <textarea
        id="req-textarea"
        name="requirements"
        rows={3}
        placeholder={"公募要領の要件を貼り付け（1行 = 1要件）\n例: 県内に主たる事業所を有すること"}
        className={inputClass}
      />
      <button type="submit" disabled={isPending} className={buttonClass}>
        {isPending ? "追加中…" : "要件を追加"}
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </form>
  );
}

/** 申請書ドラフト生成ボタン */
export function GenerateGrantDraftButton({ grantProjectId }: { grantProjectId: string }) {
  const { isPending, error, run } = useAction();
  const [done, setDone] = useState(false);
  return (
    <div>
      <button
        onClick={() =>
          run(
            () => generateGrantDraftAction(grantProjectId),
            () => setDone(true),
          )
        }
        disabled={isPending}
        className={buttonClass + " w-full"}
      >
        {isPending ? "AIがドラフト生成中…" : "申請書ドラフトをAI生成"}
      </button>
      {done ? (
        <p className="mt-1 text-sm text-green-700">
          ドラフトを生成しました。承認センター（承認タブ）でレビューしてください。
        </p>
      ) : null}
      {error ? <p className="mt-1 text-sm text-red-600">{error}</p> : null}
      <p className="mt-1 text-xs text-stone-400">
        登録済みの案件情報・充足確認済み要件・経費のみを根拠に生成します。
        生成物はドラフト保存され、承認までどこにも反映されません。
      </p>
    </div>
  );
}
