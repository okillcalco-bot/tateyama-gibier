import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { jstThisMonth } from "@/lib/jst";
import { normalizeOrderStatus } from "@/domain/orders/order-service";

export const dynamic = "force-dynamic";

/** 当月受注のCSVエクスポート（明細単位）。Excelで開けるようBOM付きUTF-8 */
export async function GET(req: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase未設定" }, { status: 503 });
  }
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const url = new URL(req.url);
  const monthParam = url.searchParams.get("month") ?? "";
  const month = /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : jstThisMonth();
  const [year, monthNum] = month.split("-").map(Number);
  const monthEnd = `${month}-${String(new Date(year, monthNum, 0).getDate()).padStart(2, "0")}`;

  const { data: orders } = await supabase
    .from("orders")
    .select("*")
    .gte("order_date", `${month}-01`)
    .lte("order_date", monthEnd)
    .order("order_date")
    .limit(1000);
  const orderRows = orders ?? [];
  const { data: items } = orderRows.length
    ? await supabase
        .from("order_items")
        .select("*")
        .in(
          "order_id",
          orderRows.map((o) => o.id),
        )
        .limit(5000)
    : { data: [] };
  const itemsByOrder = new Map<string, Record<string, unknown>[]>();
  for (const item of items ?? []) {
    const key = item.order_id as string;
    itemsByOrder.set(key, [...(itemsByOrder.get(key) ?? []), item]);
  }

  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [
    [
      "注文番号",
      "注文日",
      "納品希望日",
      "顧客名",
      "ステータス",
      "経路",
      "品目",
      "獣種",
      "重量kg",
      "単価",
      "小計",
      "注文合計",
      "メモ",
    ].join(","),
  ];
  for (const o of orderRows) {
    const orderItems = itemsByOrder.get(o.id as string) ?? [];
    const base = [
      o.order_code,
      o.order_date,
      o.delivery_date,
      o.customer_name,
      normalizeOrderStatus(o.status as string),
      o.channel,
    ];
    if (!orderItems.length) {
      lines.push(
        [...base, "", "", "", "", "", o.total_amount, o.memo ?? o.notes].map(esc).join(","),
      );
      continue;
    }
    for (const item of orderItems) {
      lines.push(
        [
          ...base,
          item.part_name,
          item.species,
          item.weight_kg ?? item.weight,
          item.unit_price,
          item.subtotal ?? item.amount,
          o.total_amount,
          o.memo ?? o.notes,
        ]
          .map(esc)
          .join(","),
      );
    }
  }

  const csv = "\uFEFF" + lines.join("\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="orders-${month}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
