"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui";
import { ADVISOR_CATEGORIES, type AdvisorCategory } from "@/ai/schemas/advisor.schema";
import {
  createConsultationAction,
  generateAdvisorBriefAction,
  closeConsultationAction,
} from "./actions";

const inputClass = "w-full rounded-lg border border-stone-300 px-3 py-2 text-sm";
const buttonClass =
  "rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";

export function NewConsultationForm() {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={buttonClass + " min-h-12 w-full"}>
        ＋ 相談を書く（税務・労務・法務・知財・行政）
      </button>
    );
  }
  return (
    <Card>
      <form
        action={(formData) => {
          setError(null);
          startTransition(async () => {
            const result = await createConsultationAction(formData);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setOpen(false);
          });
        }}
        className="space-y-2"
      >
        <select name="category" className={inputClass + " max-w-56"}>
          {(Object.entries(ADVISOR_CATEGORIES) as [AdvisorCategory, string][]).map(
            ([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ),
          )}
        </select>
        <input
          name="title"
          required
          placeholder="相談タイトル（例: 解体体験の消費税区分）"
          className={inputClass}
        />
        <textarea
          name="question"
          rows={5}
          required
          placeholder="状況と困っていることを、思いつくまま書いてください（きれいな文章でなくてOK。金額・時期・相手など事実が多いほど整理の精度が上がります）"
          className={inputClass}
        />
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

export function GenerateAdvisorButton({ consultationId }: { consultationId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  return (
    <div>
      <button
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await generateAdvisorBriefAction(consultationId);
            if (!result.ok) setError(result.error);
            else setDone(true);
          });
        }}
        disabled={isPending}
        className={buttonClass + " w-full"}
      >
        {isPending ? "AIが論点を整理中…" : "AIに論点整理してもらう"}
      </button>
      {done ? (
        <p className="mt-1 text-sm text-green-700">
          整理しました。承認センターで確認・承認するとこのページに表示されます。
        </p>
      ) : null}
      {error ? <p className="mt-1 text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

export function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="rounded-lg border border-green-700 px-3 py-1 text-xs font-semibold text-green-700"
    >
      {copied ? "コピーしました" : label}
    </button>
  );
}

export function CloseConsultationForm({ consultationId }: { consultationId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const result = await closeConsultationAction(
            consultationId,
            String(formData.get("expert_note") ?? ""),
          );
          if (!result.ok) setError(result.error);
        });
      }}
      className="space-y-2"
    >
      <textarea
        name="expert_note"
        rows={3}
        placeholder="専門家に相談した結果のメモ（例: 税理士◯◯さんに確認。体験料は10%、持ち帰り肉は8%で処理する）"
        className={inputClass}
      />
      <button type="submit" disabled={isPending} className={buttonClass}>
        {isPending ? "保存中…" : "結果を記録してクローズ"}
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </form>
  );
}
