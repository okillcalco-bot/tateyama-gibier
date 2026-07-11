"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui";
import type { ActionResult } from "@/lib/action-result";
import { CUSTOMER_TIERS, type CustomerTier } from "@/domain/board/board-service";
import {
  createBoardPostAction,
  archiveBoardPostAction,
  setCustomerTierAction,
  setStaffRoleAction,
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

/** 投稿フォーム。スタッフ向けは役割、飲食店向けは信頼度で宛先を絞る */
export function NewBoardPostForm({
  audience,
  roles,
}: {
  audience: "staff" | "customer";
  roles: string[]; // staff.role の重複なしリスト
}) {
  const { isPending, error, run } = useAction();
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={buttonClass + " w-full"}>
        ＋ {audience === "staff" ? "スタッフへの共有・指示を投稿" : "飲食店へのお知らせを投稿"}
      </button>
    );
  }
  return (
    <Card>
      <form
        action={(formData) => run(() => createBoardPostAction(formData), () => setOpen(false))}
        className="space-y-2"
      >
        <input type="hidden" name="audience" value={audience} />
        <input name="title" placeholder="タイトル（任意）" className={inputClass} />
        <textarea
          name="body"
          rows={4}
          required
          placeholder={
            audience === "staff"
              ? "共有事項・指示（例: 明日の搬入は10時。冷凍庫Bの温度チェックを毎朝お願いします）"
              : "お知らせ（例: 本日イノシシロース入荷。週末分のご注文は金曜15時まで）"
          }
          className={inputClass}
        />
        <div>
          <p className="mb-1 text-xs text-stone-500">
            宛先（選ばなければ{audience === "staff" ? "全員" : "全店"}に表示）
          </p>
          <div className="flex flex-wrap gap-3 text-sm">
            {audience === "staff"
              ? roles.map((role) => (
                  <label key={role} className="flex items-center gap-1">
                    <input type="checkbox" name="target_roles" value={role} />
                    {role}
                  </label>
                ))
              : (Object.entries(CUSTOMER_TIERS) as [CustomerTier, string][]).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-1">
                    <input type="checkbox" name="target_tiers" value={key} />
                    {label}
                  </label>
                ))}
            {audience === "staff" && !roles.length ? (
              <span className="text-xs text-stone-400">
                役割が未設定です。下の「スタッフの役割」で設定すると宛先を絞れます。
              </span>
            ) : null}
          </div>
        </div>
        <input
          name="tags"
          placeholder="タグ追加（任意・カンマ区切り。本文から自動でも付きます）"
          className={inputClass}
        />
        <div className="flex flex-wrap items-center gap-4 text-sm">
          {audience === "customer" ? (
            <label className="flex items-center gap-1">
              <input type="checkbox" name="attach_inventory" defaultChecked />
              本日の精肉在庫を添付（投稿時点のスナップショット）
            </label>
          ) : null}
          <label className="flex items-center gap-1">
            <input type="checkbox" name="pinned" />
            上部に固定
          </label>
        </div>
        <div className="flex gap-2">
          <button type="submit" disabled={isPending} className={buttonClass + " flex-1"}>
            {isPending ? "投稿中…" : "投稿"}
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

export function ArchiveBoardPostButton({ postId }: { postId: string }) {
  const { isPending, error, run } = useAction();
  return (
    <span>
      <button
        onClick={() => run(() => archiveBoardPostAction(postId))}
        disabled={isPending}
        className="text-xs text-stone-500 underline disabled:opacity-50"
      >
        アーカイブ
      </button>
      {error ? <span className="ml-1 text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

/** 飲食店の信頼度（初回/リピーター/太客）設定 */
export function CustomerTierSelect({
  customerId,
  current,
}: {
  customerId: string;
  current: string;
}) {
  const { isPending, error, run } = useAction();
  return (
    <span>
      <select
        defaultValue={current}
        disabled={isPending}
        onChange={(e) => run(() => setCustomerTierAction(customerId, e.target.value as CustomerTier))}
        className="rounded-lg border border-stone-300 px-2 py-1 text-xs disabled:opacity-50"
      >
        {(Object.entries(CUSTOMER_TIERS) as [CustomerTier, string][]).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      {error ? <span className="ml-1 text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

/** スタッフの役割設定（staff.role。ボードの宛先に使う） */
export function StaffRoleInput({
  staffId,
  name,
  currentRole,
}: {
  staffId: string;
  name: string;
  currentRole: string;
}) {
  const { isPending, error, run } = useAction();
  const [role, setRole] = useState(currentRole);
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-24 shrink-0 font-medium">{name}</span>
      <input
        value={role}
        onChange={(e) => setRole(e.target.value)}
        placeholder="役割（例: 解体 / 配送 / 事務）"
        className={inputClass + " max-w-56"}
        list="role-suggestions"
      />
      <button
        onClick={() => run(() => setStaffRoleAction(staffId, role))}
        disabled={isPending || role === currentRole}
        className="rounded-lg border border-green-700 px-3 py-1 text-xs font-semibold text-green-700 disabled:opacity-40"
      >
        保存
      </button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
