import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth";
import { jstThisMonth } from "@/lib/jst";
import { Card, CardTitle, PageHeader, SetupNotice, Badge, EmptyState } from "@/components/ui";
import { DOC_TYPES, type DocType } from "@/domain/billing/billing-service";
import {
  NewDocumentForm,
  ConvertButtons,
  VoidDocButton,
  MisocaImportForm,
} from "./billing-center-forms";

export const dynamic = "force-dynamic";

/**
 * 帳票センター（Misoca型）。
 * 見積書・納品書・請求書・領収書を1画面で作成・変換・管理する。
 * 注文由来の帳票（/orders から発行）もここに一覧される。
 */

type Row = Record<string, unknown>;

const TYPE_COLORS: Record<string, "gray" | "blue" | "green" | "amber"> = {
  quote: "blue",
  delivery_note: "gray",
  invoice: "amber",
  receipt: "green",
};

export default async function BillingCenterPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; type?: string }>;
}) {
  const params = await searchParams;
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="帳票センター" />
        <SetupNotice />
      </>
    );
  }

  const month = /^\d{4}-\d{2}$/.test(params.month ?? "") ? params.month! : jstThisMonth();
  const typeFilter = params.type && params.type in DOC_TYPES ? (params.type as DocType) : null;
  const [year, monthNum] = month.split("-").map(Number);
  const prevMonth = new Date(year, monthNum - 2, 1);
  const nextMonth = new Date(year, monthNum, 1);
  const toMonthParam = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const link = (m: string, t: string | null) =>
    `/billing?month=${m}${t ? `&type=${t}` : ""}`;

  const supabase = await createSupabaseServerClient();
  await getCurrentUser(supabase);

  let query = supabase
    .from("billing_documents")
    .select(
      "id, doc_type, doc_number, title, issue_date, customer_name, total, deleted_at, source, source_document_id, order_id",
    )
    .eq("month", month)
    .order("issue_date", { ascending: false })
    .order("seq", { ascending: false })
    .limit(300);
  if (typeFilter) query = query.eq("doc_type", typeFilter);
  const [{ data: docs }, { data: customers }] = await Promise.all([
    query,
    supabase
      .from("customers")
      .select("id, name, address, building")
      .eq("is_active", true)
      .order("name")
      .limit(200),
  ]);
  const docRows = (docs ?? []) as Row[];
  const active = docRows.filter((d) => !d.deleted_at);
  const totalByType = new Map<string, number>();
  for (const d of active) {
    totalByType.set(
      d.doc_type as string,
      (totalByType.get(d.doc_type as string) ?? 0) + (Number(d.total) || 0),
    );
  }

  return (
    <>
      <PageHeader
        title="帳票センター"
        description="見積書 → 納品書 → 請求書 → 領収書 を1か所で作成・変換・管理（Misoca代替）。"
      />
      <div className="space-y-4">
        <NewDocumentForm
          customers={(customers ?? []).map((c) => ({
            id: c.id as string,
            name: c.name as string,
            address: [c.address, c.building].filter(Boolean).join(" "),
          }))}
        />

        <MisocaImportForm />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5">
            <Link
              href={link(month, null)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${!typeFilter ? "bg-green-700 text-white" : "border border-stone-300 text-stone-600"}`}
            >
              すべて
            </Link>
            {(Object.entries(DOC_TYPES) as [DocType, { label: string }][]).map(([key, def]) => (
              <Link
                key={key}
                href={link(month, key)}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${typeFilter === key ? "bg-green-700 text-white" : "border border-stone-300 text-stone-600"}`}
              >
                {def.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-3 text-sm">
            <Link href={link(toMonthParam(prevMonth), typeFilter)} className="text-green-700 underline">
              ← 前月
            </Link>
            <span className="font-semibold">{year}年{monthNum}月</span>
            <Link href={link(toMonthParam(nextMonth), typeFilter)} className="text-green-700 underline">
              翌月 →
            </Link>
          </div>
        </div>

        {active.length ? (
          <div className="flex flex-wrap gap-3 text-xs text-stone-500">
            {[...totalByType.entries()].map(([key, value]) => (
              <span key={key}>
                {DOC_TYPES[key as DocType]?.label}: ¥{value.toLocaleString()}
              </span>
            ))}
          </div>
        ) : null}

        {docRows.length ? (
          <Card>
            <ul className="divide-y divide-stone-100 text-sm">
              {docRows.map((d) => (
                <li key={d.id as string} className="flex flex-wrap items-center gap-2 py-2">
                  <Badge color={d.deleted_at ? "red" : (TYPE_COLORS[d.doc_type as string] ?? "gray")}>
                    {DOC_TYPES[d.doc_type as DocType]?.label ?? (d.doc_type as string)}
                  </Badge>
                  <Link
                    href={`/orders/documents/${d.id}`}
                    className={`font-medium text-green-700 underline ${d.deleted_at ? "line-through opacity-60" : ""}`}
                  >
                    {d.doc_number as string}
                  </Link>
                  <span className={d.deleted_at ? "opacity-60" : ""}>
                    {(d.customer_name as string) || "（宛名なし）"} — ¥
                    {(Number(d.total) || 0).toLocaleString()}
                    <span className="ml-1 text-xs text-stone-400">{d.issue_date as string}</span>
                  </span>
                  {d.source === "misoca" ? <Badge color="gray">Misoca</Badge> : null}
                  {d.source_document_id ? (
                    <span className="text-xs text-stone-400">（変換）</span>
                  ) : null}
                  {!d.deleted_at ? (
                    <>
                      <ConvertButtons docId={d.id as string} docType={d.doc_type as DocType} />
                      <VoidDocButton docId={d.id as string} />
                    </>
                  ) : (
                    <span className="text-xs text-red-600">取消済</span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <EmptyState message="この月の帳票はまだありません。上のフォームから作成するか、Misocaからインポートしてください。" />
        )}

        <p className="text-xs text-stone-400">
          注文（受注管理）に紐づく帳票の発行は 📦 受注管理 からもできます。発行者情報
          （社名・インボイス登録番号・振込先）の設定は受注管理ページ下部の
          「⚙️ 帳票の発行者情報」で。
        </p>
      </div>
    </>
  );
}
