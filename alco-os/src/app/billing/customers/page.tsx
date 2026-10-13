import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth";
import { jstToday } from "@/lib/jst";
import { Card, CardTitle, PageHeader, SetupNotice, EmptyState, Badge } from "@/components/ui";
import {
  summarizeByCustomer,
  overallSummary,
  type CustomerSummary,
} from "@/domain/billing/customer-history";

export const dynamic = "force-dynamic";

/**
 * 顧客ごとの取引履歴（読み取り専用）。
 * Misocaから取り込んだ過去の請求 + ALCO OSで発行した帳票をまとめて、
 * 「いつ・いくら・入金したか」を顧客単位で見る。
 */

type Row = Record<string, unknown>;

function fmtDate(value: string): string {
  const [y, m, d] = value.split("-");
  return `${y}/${m}/${d}`;
}

function CustomerCard({ c, open }: { c: CustomerSummary; open: boolean }) {
  return (
    <details open={open} className="rounded-xl border border-stone-200 bg-white p-3">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-bold">{c.customerName}</span>
          <Badge color="gray">{c.count}回</Badge>
          <span className="font-semibold">¥{c.total.toLocaleString()}</span>
          {c.unpaidCount ? (
            <Badge color="red">未入金 {c.unpaidCount}件 ¥{c.unpaidTotal.toLocaleString()}</Badge>
          ) : null}
          {c.overdue ? <Badge color="amber">しばらく取引なし</Badge> : null}
        </div>
        <div className="mt-1 text-xs text-stone-500">
          最終 {fmtDate(c.lastDate)}（{c.daysSinceLast}日前）
          {c.averageIntervalDays !== null ? ` ・ ふだん約${c.averageIntervalDays}日おき` : ""}
          {" ・ 初回 "}
          {fmtDate(c.firstDate)}
        </div>
      </summary>
      <ul className="mt-2 divide-y divide-stone-100 text-sm">
        {c.transactions.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-2 py-1.5">
            <span className="text-xs text-stone-400">{fmtDate(t.issueDate)}</span>
            <span className={t.cancelled ? "line-through opacity-60" : ""}>
              ¥{t.total.toLocaleString()}
            </span>
            <code className="text-xs text-stone-400">{t.docNumber}</code>
            {t.unpaid ? <Badge color="red">未入金</Badge> : null}
            {t.cancelled ? <Badge color="gray">取消</Badge> : null}
            {t.source === "misoca" ? (
              <span className="text-xs text-stone-400">Misoca</span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export default async function BillingCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string }>;
}) {
  const params = await searchParams;
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="顧客ごとの取引履歴" />
        <SetupNotice />
      </>
    );
  }

  const keyword = (params.q ?? "").trim();
  const sort = params.sort ?? "total";
  const supabase = await createSupabaseServerClient();
  await getCurrentUser(supabase);

  const { data } = await supabase
    .from("billing_documents")
    .select("id, doc_number, doc_type, issue_date, due_date, total, customer_name, note, source, deleted_at")
    .order("issue_date", { ascending: false })
    .limit(5000);

  let summaries = summarizeByCustomer((data ?? []) as Row[], jstToday());
  const overall = overallSummary(summaries);

  if (keyword) {
    summaries = summaries.filter((c) => c.customerName.includes(keyword));
  }
  if (sort === "recent") {
    summaries = [...summaries].sort((a, b) => a.daysSinceLast - b.daysSinceLast);
  } else if (sort === "unpaid") {
    summaries = [...summaries].sort((a, b) => b.unpaidTotal - a.unpaidTotal);
  } else if (sort === "overdue") {
    summaries = [...summaries].sort(
      (a, b) => Number(b.overdue) - Number(a.overdue) || b.daysSinceLast - a.daysSinceLast,
    );
  }

  const link = (s: string) =>
    `/billing/customers?sort=${s}${keyword ? `&q=${encodeURIComponent(keyword)}` : ""}`;
  const chip = (s: string) =>
    `rounded-full px-3 py-1 text-xs font-semibold ${sort === s ? "bg-green-700 text-white" : "border border-stone-300 text-stone-600"}`;

  return (
    <>
      <PageHeader
        title="顧客ごとの取引履歴"
        description="Misocaから取り込んだ過去の請求と、発行した帳票を顧客単位でまとめています（表示のみ）。"
      />
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Card>
            <CardTitle>取引先</CardTitle>
            <p className="text-2xl font-bold">{overall.customerCount}社</p>
          </Card>
          <Card>
            <CardTitle>取引件数</CardTitle>
            <p className="text-2xl font-bold">{overall.transactionCount}件</p>
          </Card>
          <Card>
            <CardTitle>累計金額</CardTitle>
            <p className="text-2xl font-bold">¥{overall.total.toLocaleString()}</p>
          </Card>
          <Card className={overall.unpaidCount ? "border-red-300 bg-red-50" : ""}>
            <CardTitle>未入金</CardTitle>
            <p className="text-2xl font-bold">
              {overall.unpaidCount}件
            </p>
            <p className="text-xs text-stone-500">¥{overall.unpaidTotal.toLocaleString()}</p>
          </Card>
        </div>

        <Card>
          <form method="get" className="flex flex-wrap gap-2">
            <input type="hidden" name="sort" value={sort} />
            <input
              name="q"
              defaultValue={keyword}
              placeholder="取引先を検索"
              className="min-h-11 flex-1 rounded-lg border border-stone-300 px-3 text-base"
            />
            <button
              type="submit"
              className="min-h-11 rounded-lg bg-green-700 px-4 text-sm font-semibold text-white"
            >
              検索
            </button>
          </form>
          <div className="mt-2 flex flex-wrap gap-2">
            <Link href={link("total")} className={chip("total")}>
              金額が大きい順
            </Link>
            <Link href={link("recent")} className={chip("recent")}>
              最近の取引順
            </Link>
            <Link href={link("unpaid")} className={chip("unpaid")}>
              未入金が多い順
            </Link>
            <Link href={link("overdue")} className={chip("overdue")}>
              しばらく取引がない順
            </Link>
          </div>
        </Card>

        {summaries.length ? (
          <div className="space-y-2">
            {summaries.map((c) => (
              <CustomerCard key={c.customerName} c={c} open={Boolean(keyword) && summaries.length <= 3} />
            ))}
          </div>
        ) : (
          <EmptyState
            message={
              keyword
                ? "その取引先は見つかりませんでした。"
                : "取引がまだありません。帳票センターの「📥 Misocaからデータを移行する」で過去の請求を取り込めます。"
            }
          />
        )}

        <p className="text-xs text-stone-400">
          「しばらく取引なし」は、ふだんの取引間隔の1.5倍を過ぎた取引先の目安です。
          Misocaの一覧CSVには明細（何を買ったか）が含まれないため、ここでは日付・金額・入金までを表示します。
        </p>
      </div>
    </>
  );
}
