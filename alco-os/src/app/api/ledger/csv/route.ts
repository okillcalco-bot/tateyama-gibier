import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { jstThisMonth } from "@/lib/jst";
import {
  SLIP_CATEGORIES,
  PAYMENT_METHODS,
  type SlipCategory,
  type PaymentMethod,
} from "@/domain/ledger/ledger-service";

export const dynamic = "force-dynamic";

/** 売上伝票の月次CSV（税理士連携用）。取消済みも「取消」列付きで出力する */
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

  const { data: slips } = await supabase
    .from("sales_slips")
    .select("*")
    .eq("month", month)
    .order("seq")
    .limit(2000);

  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [
    ["伝票番号", "日付", "種別", "品目", "数量", "金額(税込)", "支払方法", "担当", "メモ", "取消"].join(","),
  ];
  for (const s of slips ?? []) {
    lines.push(
      [
        s.slip_number,
        s.sale_date,
        SLIP_CATEGORIES[s.category as SlipCategory] ?? s.category,
        s.item,
        s.quantity,
        s.amount,
        PAYMENT_METHODS[s.payment_method as PaymentMethod] ?? s.payment_method,
        s.staff_name,
        s.note,
        s.deleted_at ? "取消" : "",
      ]
        .map(esc)
        .join(","),
    );
  }

  return new NextResponse("\uFEFF" + lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sales-slips-${month}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
