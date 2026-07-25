"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui";
import type { ActionResult } from "@/lib/action-result";
import {
  createQuestAction,
  publishQuestAction,
  updateQuestProgressAction,
  confirmPledgeAction,
  cancelPledgeAction,
  recordPayoutAction,
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

export interface SiteOption {
  id: string;
  name: string;
}

/** クエスト作成（ギャップ表の「タスク案」からワンタップで下書きできる） */
export function NewQuestForm({
  sites,
  presets,
}: {
  sites: SiteOption[];
  presets: { title: string; taxonGroup: string; season: string; missing: number }[];
}) {
  const { isPending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<(typeof presets)[number] | null>(null);

  if (!open) {
    return (
      <div className="space-y-2">
        <button onClick={() => setOpen(true)} className={buttonClass + " min-h-12 w-full"}>
          ＋ クエストをつくる（応援を集めて調査する）
        </button>
        {presets.length ? (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-xs text-stone-400">不足から作る:</span>
            {presets.slice(0, 5).map((p, i) => (
              <button
                key={i}
                onClick={() => {
                  setPreset(p);
                  setOpen(true);
                }}
                className="rounded-full border border-green-700 px-3 py-1 text-xs text-green-700"
              >
                {p.taxonGroup}・あと{p.missing}件
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Card>
      <form
        action={(formData) => run(() => createQuestAction(formData), () => setOpen(false))}
        className="space-y-2"
      >
        <input
          name="title"
          required
          defaultValue={preset?.title ?? ""}
          placeholder="クエスト名（例: 夏のコウモリ調査を3回やりきる）"
          className={inputClass}
        />
        <textarea
          name="story"
          rows={3}
          placeholder="応援者向けの説明（なぜこの調査が必要か・分かると何が変わるか）"
          className={inputClass}
        />
        <div className="flex flex-wrap gap-2">
          <select name="site_id" className={inputClass + " max-w-48"}>
            <option value="">対象地（任意）</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input
            name="taxon_group"
            defaultValue={preset?.taxonGroup ?? ""}
            placeholder="分類群"
            className={inputClass + " max-w-32"}
          />
          <select name="season" defaultValue={preset?.season ?? ""} className={inputClass + " max-w-32"}>
            <option value="">季節（任意）</option>
            <option value="spring">春</option>
            <option value="summer">夏</option>
            <option value="autumn">秋</option>
            <option value="winter">冬</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-stone-500">
            目標件数
            <input
              name="target_count"
              type="number"
              min="1"
              defaultValue={preset?.missing || 3}
              className={inputClass + " max-w-24"}
            />
          </label>
          <label className="text-xs text-stone-500">
            必要資金（円）
            <input
              name="funding_goal_yen"
              type="number"
              min="0"
              step="1000"
              defaultValue={30000}
              className={inputClass + " max-w-32"}
            />
          </label>
          <input
            name="reward_title"
            placeholder="達成でもらえる称号（例: 夜の里山の耳）"
            className={inputClass}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="restricted" />
          希少種を含む（公開・応援募集をしない。認定調査者への個別依頼にする）
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={isPending} className={buttonClass + " flex-1"}>
            {isPending ? "作成中…" : "作成"}
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

export function PublishQuestButton({
  questId,
  published,
  restricted,
}: {
  questId: string;
  published: boolean;
  restricted: boolean;
}) {
  const { isPending, error, run } = useAction();
  if (restricted) {
    return <span className="text-xs text-stone-400">🔒 非公開（希少種）</span>;
  }
  return (
    <span>
      <button
        onClick={() => run(() => publishQuestAction(questId, !published))}
        disabled={isPending}
        className={
          published
            ? "text-xs text-stone-500 underline disabled:opacity-50"
            : "rounded-lg bg-green-700 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
        }
      >
        {published ? "公開停止" : "公開して応援を募る"}
      </button>
      {error ? <span className="ml-1 text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

export function ProgressButton({
  questId,
  progressCount,
}: {
  questId: string;
  progressCount: number;
}) {
  const { isPending, error, run } = useAction();
  return (
    <span>
      <button
        onClick={() => run(() => updateQuestProgressAction(questId, progressCount + 1))}
        disabled={isPending}
        className="rounded-lg border border-green-700 px-2 py-1 text-xs font-semibold text-green-700 disabled:opacity-50"
      >
        +1 進める
      </button>
      {error ? <span className="ml-1 text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

export function PledgeActions({ pledgeId, status }: { pledgeId: string; status: string }) {
  const { isPending, error, run } = useAction();
  if (status !== "pledged") {
    return (
      <span className="text-xs text-stone-400">
        {status === "confirmed" ? "入金確認済み" : status === "refunded" ? "返金済み" : "取消済み"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={() => run(() => confirmPledgeAction(pledgeId))}
        disabled={isPending}
        className="rounded-lg bg-green-700 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
      >
        入金を確認
      </button>
      <button
        onClick={() => {
          if (confirm("この応援を取り消しますか？")) run(() => cancelPledgeAction(pledgeId, "cancelled"));
        }}
        disabled={isPending}
        className="text-xs text-stone-500 underline disabled:opacity-50"
      >
        取消
      </button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

/** 調査への支払い記録（＝地域の仕事になった金額） */
export function PayoutForm({ questId, availableYen }: { questId: string; availableYen: number }) {
  const { isPending, error, run } = useAction();
  const today = new Date().toLocaleDateString("sv-SE");
  return (
    <details className="mt-2 rounded-lg bg-stone-50 p-2">
      <summary className="cursor-pointer text-xs font-semibold text-green-700">
        💴 調査への支払いを記録（残り ¥{availableYen.toLocaleString()}）
      </summary>
      <form action={(formData) => run(() => recordPayoutAction(formData))} className="mt-2 space-y-2">
        <input type="hidden" name="task_id" value={questId} />
        <div className="flex flex-wrap gap-2">
          <input name="payee_name" required placeholder="支払先（調査員・協力者）" className={inputClass} />
          <input
            name="amount_yen"
            type="number"
            min="1"
            required
            placeholder="金額"
            className={inputClass + " max-w-28"}
          />
          <input name="paid_on" type="date" defaultValue={today} required className={inputClass + " max-w-40"} />
        </div>
        <div className="flex gap-2">
          <input name="purpose" placeholder="内容（謝金 / 交通費 / 機材 等）" className={inputClass} />
          <button type="submit" disabled={isPending} className={buttonClass + " shrink-0"}>
            {isPending ? "記録中…" : "記録"}
          </button>
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <p className="text-xs text-stone-400">
          応援金の残りを超える支払いは登録できません（お金の整合性を守るため）。
        </p>
      </form>
    </details>
  );
}

/** 応援ページのURLをコピー */
export function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="rounded-lg border border-green-700 px-2 py-1 text-xs font-semibold text-green-700"
    >
      {copied ? "コピーしました" : "🔗 応援リンク"}
    </button>
  );
}
