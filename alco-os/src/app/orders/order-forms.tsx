"use client";

import { useTransition, useState } from "react";
import { updateOrderStatusAction } from "./actions";
import { ORDER_STATUSES, type OrderStatus } from "@/domain/orders/order-service";

/** 受注ステータス変更（order-portal.html と同じ語彙: 受注→確認済→発送済→納品完了） */
export function OrderStatusSelect({
  orderId,
  current,
}: {
  orderId: string;
  current: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onChange = (status: string) => {
    if (status === current) return;
    if (status === "キャンセル" && !confirm("この注文をキャンセルにしますか？")) return;
    setError(null);
    startTransition(async () => {
      const result = await updateOrderStatusAction(orderId, status as OrderStatus);
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <span>
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        disabled={isPending}
        className="rounded-lg border border-stone-300 px-2 py-1 text-xs disabled:opacity-50"
      >
        {!ORDER_STATUSES.includes(current as OrderStatus) ? (
          <option value={current}>{current}</option>
        ) : null}
        {ORDER_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {error ? <span className="ml-1 text-xs text-red-600">{error}</span> : null}
    </span>
  );
}
