import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth";
import { jstThisMonth } from "@/lib/jst";
import { Card, CardTitle, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";
import {
  SLIP_CATEGORIES,
  PAYMENT_METHODS,
  type SlipCategory,
  type PaymentMethod,
} from "@/domain/ledger/ledger-service";
import { NewSalesSlipForm, VoidSlipButton } from "./ledger-forms";

export const dynamic = "force-dynamic";

/**
 * 経理・売上伝票。手売り/解体体験/イベント等の「領収書不要の売上」を
 * スマホから記録し、月次集計・CSV（税理士連携）まで行う。
 * 領収書が必要な場合は /orders の帳票発行を使う。
 */

type Row = Record<string, unknown>;

export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="経理・売上伝票" />
        <SetupNotice />
      </>
    );
  }

  const month = /^\d{4}-\d{2}$/.test(params.month ?? "") ? params.month! : jstThisMonth();
  const [year, monthNum] = month.split("-").map(Number);
  const prevMonth = new Date(year, monthNum - 2, 1);
  const nextMonth = new Date(year, monthNum, 1);
  const toMonthParam = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

  const supabase = await createSupabaseServerClient();
  await getCurrentUser(supabase);

  const [{ data: slips }, { data: staff }, { data: products }, { data: priceMaster }] =
    await Promise.all([
      supabase
        .from("sales_slips")
        .select("*")
        .eq("month", month)
        .order("seq", { ascending: false })
        .limit(500),
      supabase
        .from("staff")
        .select("name")
        .eq("is_active", true)
        .is("deleted_at", null)
        .order("name"),
      supabase
        .from("products")
        .select("id, name, unit, price, stock_qty, deleted_at")
        .is("deleted_at", null)
        .order("category")
        .order("name")
        .limit(300),
      supabase
        .from("price_master")
        .select("id, species, part_name, price_standard, price_premium, price_wholesale")
        .order("species")
        .order("part_name")
        .limit(300),
    ]);
  const slipRows = (slips ?? []) as Row[];
  const active = slipRows.filter((s) => !s.deleted_at);

  const total = active.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  const byCategory = new Map<string, number>();
  const byPayment = new Map<string, number>();
  for (const s of active) {
    byCategory.set(s.category as string, (byCategory.get(s.category as string) ?? 0) + Number(s.amount));
    byPayment.set(
      s.payment_method as string,
      (byPayment.get(s.payment_method as string) ?? 0) + Number(s.amount),
    );
  }

  return (
    <>
      <PageHeader
        title="経理・売上伝票"
        description="手売り・解体体験など、領収書不要の売上をその場で記録。領収書が必要なら受注管理の帳票発行へ。"
      />
      <div className="space-y-4">
        <NewSalesSlipForm
          staffNames={(staff ?? []).map((s) => s.name as string)}
          products={(products ?? []) as Record<string, unknown>[]}
          priceMaster={(priceMaster ?? []) as Record<string, unknown>[]}
        />

        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-stone-700">
            {year}年{monthNum}月 合計 ¥{total.toLocaleString()}（{active.length}件）
          </h2>
          <div className="flex items-center gap-3 text-sm">
            <Link href={`/ledger?month=${toMonthParam(prevMonth)}`} className="text-green-700 underline">
              ← 前月
            </Link>
            <Link href={`/ledger?month=${toMonthParam(nextMonth)}`} className="text-green-700 underline">
              翌月 →
            </Link>
            <a
              href={`/api/ledger/csv?month=${month}`}
              className="rounded-lg border border-green-700 px-3 py-1 text-xs font-semibold text-green-700"
            >
              ⬇ CSV（税理士用）
            </a>
          </div>
        </div>

        {active.length ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardTitle>種別ごと</CardTitle>
              <table className="w-full text-sm">
                <tbody>
                  {[...byCategory.entries()].map(([key, value]) => (
                    <tr key={key} className="border-t border-stone-100">
                      <td className="py-1">{SLIP_CATEGORIES[key as SlipCategory] ?? key}</td>
                      <td className="py-1 text-right font-medium">¥{value.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card>
              <CardTitle>支払方法ごと（レジ締め用）</CardTitle>
              <table className="w-full text-sm">
                <tbody>
                  {[...byPayment.entries()].map(([key, value]) => (
                    <tr key={key} className="border-t border-stone-100">
                      <td className="py-1">{PAYMENT_METHODS[key as PaymentMethod] ?? key}</td>
                      <td className="py-1 text-right font-medium">¥{value.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        ) : null}

        {slipRows.length ? (
          <Card>
            <CardTitle>伝票一覧</CardTitle>
            <ul className="divide-y divide-stone-100 text-sm">
              {slipRows.map((s) => (
                <li key={s.id as string} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="text-xs text-stone-400">{s.slip_number as string}</span>
                  <Badge color={s.deleted_at ? "red" : "gray"}>
                    {SLIP_CATEGORIES[s.category as SlipCategory] ?? (s.category as string)}
                  </Badge>
                  <span className={s.deleted_at ? "line-through opacity-60" : ""}>
                    {s.product_id ? "🐗" : ""}
                    {s.sale_date as string} {s.item as string}
                    {s.quantity ? ` ×${s.quantity}` : ""} —{" "}
                    <strong>¥{Number(s.amount).toLocaleString()}</strong>（
                    {PAYMENT_METHODS[s.payment_method as PaymentMethod] ?? (s.payment_method as string)}）
                    {s.staff_name ? ` ・${s.staff_name}` : ""}
                  </span>
                  {s.deleted_at ? (
                    <span className="text-xs text-red-600">取消済</span>
                  ) : (
                    <VoidSlipButton slipId={s.id as string} />
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <EmptyState message="この月の伝票はまだありません。上のフォームから登録してください。" />
        )}
      </div>
    </>
  );
}
