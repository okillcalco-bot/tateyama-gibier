"use client";

import { useTransition, useState } from "react";
import { Card } from "@/components/ui";
import type { ActionResult } from "@/lib/action-result";
import {
  createShiftPatternAction,
  toggleShiftPatternAction,
  assignShiftAction,
  removeShiftAction,
  createShiftRequestAction,
  reflectShiftRequestAction,
} from "./actions";

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

export interface StaffOption {
  id: string;
  name: string;
}
export interface PatternOption {
  id: string;
  name: string;
  short_label: string;
  start_time: string;
  end_time: string;
  is_active: boolean;
}

/** 固定のシフト種別（パターン以外）。休みも表に載せる（HRMOS流） */
export const FIXED_SHIFT_TYPES = ["公休", "有休"];

/** シフト割当フォーム（同一スタッフ・同一日は上書き） */
export function ShiftAssignForm({
  staff,
  patterns,
}: {
  staff: StaffOption[];
  patterns: PatternOption[];
}) {
  const { isPending, error, run } = useAction();
  return (
    <form
      action={(formData) => run(() => assignShiftAction(formData), () => {})}
      className="space-y-2"
    >
      <div className="flex flex-wrap gap-2">
        <select name="staff_id" required className={inputClass + " max-w-40"}>
          <option value="">スタッフ</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select name="shift_type" required className={inputClass + " max-w-40"}>
          {patterns
            .filter((p) => p.is_active)
            .map((p) => (
              <option key={p.id} value={p.name}>
                {p.name}（{p.start_time.slice(0, 5)}-{p.end_time.slice(0, 5)}）
              </option>
            ))}
          {FIXED_SHIFT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input name="date" type="date" required className={inputClass + " max-w-40"} />
      </div>
      <input
        name="extra_dates"
        placeholder="同じ内容で入れる他の日（例: 2026-07-15, 2026-07-16）"
        className={inputClass}
      />
      <div className="flex flex-wrap items-center gap-2">
        <input name="start_time" type="time" className={inputClass + " max-w-28"} />
        <span className="text-xs text-stone-400">〜</span>
        <input name="end_time" type="time" className={inputClass + " max-w-28"} />
        <span className="text-xs text-stone-400">（空欄ならパターンの時刻）</span>
      </div>
      <div className="flex gap-2">
        <input name="note" placeholder="メモ" className={inputClass} />
        <button type="submit" disabled={isPending} className={buttonClass + " shrink-0"}>
          {isPending ? "登録中…" : "シフト登録"}
        </button>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </form>
  );
}

export function RemoveShiftButton({ shiftId }: { shiftId: string }) {
  const { isPending, error, run } = useAction();
  return (
    <span>
      <button
        onClick={() => run(() => removeShiftAction(shiftId))}
        disabled={isPending}
        className="text-xs text-red-600 underline disabled:opacity-50"
      >
        削除
      </button>
      {error ? <span className="ml-1 text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

/** シフトパターン登録（HRMOSのパターン登録に相当） */
export function ShiftPatternForm() {
  const { isPending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm text-green-700 underline">
        ＋ パターンを追加
      </button>
    );
  }
  return (
    <Card>
      <form
        action={(formData) => run(() => createShiftPatternAction(formData), () => setOpen(false))}
        className="space-y-2"
      >
        <div className="flex flex-wrap gap-2">
          <input name="name" required placeholder="パターン名（例: 日勤）" className={inputClass + " max-w-40"} />
          <input name="short_label" placeholder="表の表示（例: 日）" className={inputClass + " max-w-32"} />
          <input name="color" type="color" defaultValue="#3B82F6" className="h-10 w-14 rounded border border-stone-300" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input name="start_time" type="time" required className={inputClass + " max-w-28"} />
          <span className="text-xs text-stone-400">〜</span>
          <input name="end_time" type="time" required className={inputClass + " max-w-28"} />
          <input
            name="break_minutes"
            type="number"
            min="0"
            defaultValue={60}
            className={inputClass + " max-w-24"}
          />
          <span className="text-xs text-stone-400">休憩(分)</span>
        </div>
        <div className="flex gap-2">
          <button type="submit" disabled={isPending} className={buttonClass}>
            {isPending ? "登録中…" : "パターン登録"}
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

export function PatternToggleButton({ patternId, isActive }: { patternId: string; isActive: boolean }) {
  const { isPending, run } = useAction();
  return (
    <button
      onClick={() => run(() => toggleShiftPatternAction(patternId, !isActive))}
      disabled={isPending}
      className="text-xs text-stone-500 underline disabled:opacity-50"
    >
      {isActive ? "使わない" : "使う"}
    </button>
  );
}

/** 希望シフト提出（スタッフの出勤希望・休み希望） */
export function ShiftRequestForm({ staff }: { staff: StaffOption[] }) {
  const { isPending, error, run } = useAction();
  return (
    <form
      action={(formData) => run(() => createShiftRequestAction(formData))}
      className="space-y-2"
    >
      <div className="flex flex-wrap gap-2">
        <select name="staff_id" required className={inputClass + " max-w-40"}>
          <option value="">スタッフ</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <input name="work_date" type="date" required className={inputClass + " max-w-40"} />
        <select name="preference" className={inputClass + " max-w-40"}>
          <option value="ok">出られる</option>
          <option value="ng">休み希望</option>
          <option value="partial">時間指定あり</option>
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input name="start_time" type="time" className={inputClass + " max-w-28"} />
        <span className="text-xs text-stone-400">〜</span>
        <input name="end_time" type="time" className={inputClass + " max-w-28"} />
        <input name="note" placeholder="メモ" className={inputClass} />
        <button type="submit" disabled={isPending} className={buttonClass + " shrink-0"}>
          {isPending ? "送信中…" : "希望を出す"}
        </button>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </form>
  );
}

export function ReflectRequestButton({ requestId }: { requestId: string }) {
  const { isPending, run } = useAction();
  return (
    <button
      onClick={() => run(() => reflectShiftRequestAction(requestId))}
      disabled={isPending}
      className="text-xs text-green-700 underline disabled:opacity-50"
    >
      反映済みにする
    </button>
  );
}
