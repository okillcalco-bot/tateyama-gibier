import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth";
import { jstThisMonth } from "@/lib/jst";
import { normalizeOrderStatus } from "@/domain/orders/order-service";
import { Card, CardTitle, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";
import { OrderStatusSelect } from "./order-forms";

export const dynamic = "force-dynamic";

/**
 * 受注管理（タノム型の受注バックオフィス）。
 * 注文は order-portal.html（顧客向け）から入り、ここで確認〜納品まで進める。
 */

type Row = Record<string, string | number | boolean | null>;

const STATUS_COLORS: Record<string, "gray" | "blue" | "green" | "amber" | "red"> = {
  受注: "amber",
  確認済: "blue",
  発送済: "green",
  納品完了: "gray",
  キャンセル: "red",
};

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="受注管理" />
        <SetupNotice />
      </>
    );
  }

  const month = /^\d{4}-\d{2}$/.test(params.month ?? "") ? params.month! : jstThisMonth();
  const [year, monthNum] = month.split("-").map(Number);
  const daysInMonth = new Date(year, monthNum, 0).getDate();
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  const prevMonth = new Date(year, monthNum - 2, 1);
  const nextMonth = new Date(year, monthNum, 1);
  const toMonthParam = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

  const supabase = await createSupabaseServerClient();
  await getCurrentUser(supabase);

  const { data: orders } = await supabase
    .from("orders")
    .select("*")
    .gte("order_date", monthStart)
    .lte("order_date", monthEnd)
    .order("created_at", { ascending: false })
    .limit(300);
  const orderRows = (orders ?? []) as Row[];

  const orderIds = orderRows.map((o) => o.id as string);
  const { data: items } = orderIds.length
    ? await supabase.from("order_items").select("*").in("order_id", orderIds).limit(2000)
    : { data: [] };
  const itemRows = (items ?? []) as Row[];
  const itemsByOrder = new Map<string, Row[]>();
  for (const item of itemRows) {
    const key = item.order_id as string;
    itemsByOrder.set(key, [...(itemsByOrder.get(key) ?? []), item]);
  }

  // 未完了（当月以外も含む）を先頭に出す — タノムの「新着注文」に相当
  const { data: openOrders } = await supabase
    .from("orders")
    .select("*")
    .in("status", ["受注", "受付"])
    .order("created_at", { ascending: false })
    .limit(50);
  const openRows = ((openOrders ?? []) as Row[]).filter(
    (o) => !orderRows.some((m) => m.id === o.id),
  );

  // 集計（顧客別・品目別）
  const active = orderRows.filter((o) => normalizeOrderStatus(o.status as string) !== "キャンセル");
  const byCustomer = new Map<string, { count: number; total: number }>();
  for (const o of active) {
    const name = (o.customer_name as string) || "（名前なし）";
    const entry = byCustomer.get(name) ?? { count: 0, total: 0 };
    entry.count += 1;
    entry.total += Number(o.total_amount) || 0;
    byCustomer.set(name, entry);
  }
  const activeIds = new Set(active.map((o) => o.id));
  const byItem = new Map<string, { count: number; weight: number; subtotal: number }>();
  for (const item of itemRows) {
    if (!activeIds.has(item.order_id)) continue;
    const name = `${item.species ? `${item.species} ` : ""}${item.part_name}`;
    const entry = byItem.get(name) ?? { count: 0, weight: 0, subtotal: 0 };
    entry.count += 1;
    entry.weight += Number(item.weight_kg ?? item.weight) || 0;
    entry.subtotal += Number(item.subtotal ?? item.amount) || 0;
    byItem.set(name, entry);
  }

  const renderOrder = (o: Row) => {
    const status = normalizeOrderStatus(o.status as string);
    const orderItems = itemsByOrder.get(o.id as string) ?? [];
    return (
      <Card key={o.id as string}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">
              {(o.customer_name as string) || "（名前なし）"}
              <span className="ml-2 text-xs font-normal text-stone-400">
                {o.order_code as string}
              </span>
            </p>
            <p className="text-xs text-stone-400">
              注文 {o.order_date as string}
              {o.delivery_date ? ` ・納品希望 ${o.delivery_date as string}` : ""}
              {o.channel ? ` ・${o.channel as string}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge color={STATUS_COLORS[status] ?? "gray"}>{status}</Badge>
            <OrderStatusSelect orderId={o.id as string} current={status} />
          </div>
        </div>
        {orderItems.length ? (
          <ul className="mt-2 text-sm text-stone-600">
            {orderItems.map((item) => (
              <li key={item.id as string}>
                {item.species ? `${item.species} ` : ""}
                {item.part_name as string}
                {item.weight_kg ?? item.weight
                  ? ` ${Number(item.weight_kg ?? item.weight)}kg`
                  : ""}
                {item.subtotal ?? item.amount
                  ? ` ¥${Number(item.subtotal ?? item.amount).toLocaleString()}`
                  : ""}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-1 text-sm font-semibold text-stone-700">
          合計 ¥{(Number(o.total_amount) || 0).toLocaleString()}
        </p>
        {o.memo || o.notes ? (
          <p className="mt-1 text-xs text-stone-500">📝 {(o.memo ?? o.notes) as string}</p>
        ) : null}
      </Card>
    );
  };

  return (
    <>
      <PageHeader
        title="受注管理"
        description="注文ポータル（order-portal）から入った注文の確認〜納品まで。"
      />

      <div className="space-y-4">
        {openRows.length ? (
          <div>
            <h2 className="mb-2 text-sm font-semibold text-amber-700">
              🔔 未確認の注文（当月以外 {openRows.length}件）
            </h2>
            <div className="space-y-3">{openRows.map(renderOrder)}</div>
          </div>
        ) : null}

        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-stone-700">
            {year}年{monthNum}月の注文（{orderRows.length}件）
          </h2>
          <div className="flex items-center gap-3 text-sm">
            <Link href={`/orders?month=${toMonthParam(prevMonth)}`} className="text-green-700 underline">
              ← 前月
            </Link>
            <Link href={`/orders?month=${toMonthParam(nextMonth)}`} className="text-green-700 underline">
              翌月 →
            </Link>
            <a
              href={`/api/orders/csv?month=${month}`}
              className="rounded-lg border border-green-700 px-3 py-1 text-xs font-semibold text-green-700"
            >
              ⬇ CSV
            </a>
          </div>
        </div>

        {orderRows.length ? (
          <div className="space-y-3">{orderRows.map(renderOrder)}</div>
        ) : (
          <EmptyState message="この月の注文はまだありません。" />
        )}

        {active.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardTitle>顧客別集計（キャンセル除く）</CardTitle>
              <table className="w-full text-sm">
                <tbody>
                  {[...byCustomer.entries()]
                    .sort((a, b) => b[1].total - a[1].total)
                    .map(([name, v]) => (
                      <tr key={name} className="border-t border-stone-100">
                        <td className="py-1">{name}</td>
                        <td className="py-1 text-right text-stone-500">{v.count}件</td>
                        <td className="py-1 text-right font-medium">¥{v.total.toLocaleString()}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </Card>
            <Card>
              <CardTitle>品目別集計（キャンセル除く）</CardTitle>
              <table className="w-full text-sm">
                <tbody>
                  {[...byItem.entries()]
                    .sort((a, b) => b[1].subtotal - a[1].subtotal)
                    .map(([name, v]) => (
                      <tr key={name} className="border-t border-stone-100">
                        <td className="py-1">{name}</td>
                        <td className="py-1 text-right text-stone-500">
                          {v.weight ? `${v.weight.toFixed(1)}kg` : `${v.count}件`}
                        </td>
                        <td className="py-1 text-right font-medium">
                          ¥{v.subtotal.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </Card>
          </div>
        ) : null}
      </div>
    </>
  );
}
