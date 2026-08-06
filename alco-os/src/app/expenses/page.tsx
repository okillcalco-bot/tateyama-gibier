import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/lib/auth";
import { jstToday, jstThisMonth } from "@/lib/jst";
import { Card, CardTitle, PageHeader, SetupNotice, EmptyState } from "@/components/ui";
import { receiptOutputSchema } from "@/ai/schemas/receipt.schema";
import { summarizeExpenses } from "@/domain/accounting/expense-service";
import {
  ReceiptUploadForm,
  ReceiptConfirmForm,
  ManualExpenseForm,
  ExpenseItem,
  type ReceiptSuggestion,
  type ExpenseRow,
} from "./expense-forms";

export const dynamic = "force-dynamic";

/**
 * 経費（レシート）。
 * 撮る → AIが読む → **人が確認して登録** → 月ごとに集計。
 * 税理士へ渡す紙の受け渡しを減らすことが目的。原本の廃棄可否は税理士に要確認。
 */

type Row = Record<string, unknown>;

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  if (!isSupabaseConfigured()) {
    return (
      <>
        <PageHeader title="経費・レシート" />
        <SetupNotice />
      </>
    );
  }

  const month = /^\d{4}-\d{2}$/.test(params.month ?? "") ? params.month! : jstThisMonth();
  const [year, monthNum] = month.split("-").map(Number);
  const monthStart = `${month}-01`;
  const nextMonthStart = `${monthNum === 12 ? year + 1 : year}-${String(monthNum === 12 ? 1 : monthNum + 1).padStart(2, "0")}-01`;
  const toMonthParam = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

  const supabase = await createSupabaseServerClient();
  await getCurrentUser(supabase);

  const [{ data: drafts }, { data: expenses }] = await Promise.all([
    supabase
      .from("generated_drafts")
      .select("id, content, source_id, created_at")
      .eq("draft_type", "receipt_result")
      .eq("status", "draft")
      .order("created_at", { ascending: true })
      .limit(50),
    supabase
      .from("expenses")
      .select(
        "id, expense_date, amount, vendor, category, payment_method, invoice_number, note, corrected, deleted_at, receipt_file_id",
      )
      .gte("expense_date", monthStart)
      .lt("expense_date", nextMonthStart)
      .order("expense_date", { ascending: false })
      .limit(500),
  ]);

  const draftRows = (drafts ?? []) as Row[];
  const expenseRows = (expenses ?? []) as Row[];
  const summary = summarizeExpenses(expenseRows);

  // 写真は非公開バケット。表示のたびに署名URLを作る（1時間で失効）
  const fileIds = [
    ...draftRows.map((d) => d.source_id),
    ...expenseRows.map((e) => e.receipt_file_id),
  ].filter((v): v is string => typeof v === "string" && v.length > 0);
  const photoUrlByFileId = new Map<string, string>();
  if (fileIds.length > 0) {
    const { data: files } = await supabase
      .from("files")
      .select("id, bucket, path")
      .in("id", [...new Set(fileIds)]);
    for (const file of files ?? []) {
      const { data: signed } = await supabase.storage
        .from(file.bucket as string)
        .createSignedUrl(file.path as string, 3600);
      if (signed?.signedUrl) photoUrlByFileId.set(file.id as string, signed.signedUrl);
    }
  }

  const suggestions: ReceiptSuggestion[] = draftRows.map((d) => {
    const parsed = receiptOutputSchema.safeParse(d.content);
    const content = parsed.success ? parsed.data : receiptOutputSchema.parse({});
    return {
      draftId: d.id as string,
      photoUrl: (typeof d.source_id === "string" && photoUrlByFileId.get(d.source_id)) || null,
      expenseDate: content.expense_date ?? jstToday(),
      amount: content.amount,
      vendor: content.vendor,
      category: content.category,
      paymentMethod: content.payment_method,
      taxRate: content.tax_rate,
      taxAmount: content.tax_amount,
      invoiceNumber: content.invoice_number,
      note: content.note,
      uncertainFields: parsed.success ? content.uncertain_fields : ["expense_date", "amount", "vendor"],
      items: content.items,
    };
  });

  const list: ExpenseRow[] = expenseRows.map((e) => ({
    id: e.id as string,
    expenseDate: e.expense_date as string,
    amount: Number(e.amount) || 0,
    vendor: (e.vendor as string) ?? "",
    category: (e.category as string) ?? "",
    paymentMethod: (e.payment_method as string) ?? "",
    invoiceNumber: (e.invoice_number as string) ?? "",
    note: (e.note as string) ?? "",
    corrected: Boolean(e.corrected),
    voided: Boolean(e.deleted_at),
    photoUrl:
      (typeof e.receipt_file_id === "string" && photoUrlByFileId.get(e.receipt_file_id)) || null,
  }));

  return (
    <>
      <PageHeader
        title="経費・レシート"
        description="レシートを撮ると、日付・金額・支払先をAIが読み取ります。登録するのは自分で確認してからです。"
      />
      <div className="space-y-4">
        <Card>
          <ReceiptUploadForm />
        </Card>

        {suggestions.length > 0 ? (
          <section className="space-y-3">
            <h2 className="text-lg font-bold text-amber-800">
              確認待ち {suggestions.length}件
            </h2>
            {suggestions.map((s) => (
              <ReceiptConfirmForm key={s.draftId} suggestion={s} />
            ))}
          </section>
        ) : null}

        <div className="flex items-center justify-between gap-3 text-sm">
          <Link
            href={`/expenses?month=${toMonthParam(new Date(year, monthNum - 2, 1))}`}
            className="text-green-700 underline"
          >
            ← 前月
          </Link>
          <span className="font-semibold">
            {year}年{monthNum}月
          </span>
          <Link
            href={`/expenses?month=${toMonthParam(new Date(year, monthNum, 1))}`}
            className="text-green-700 underline"
          >
            翌月 →
          </Link>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Card>
            <CardTitle>この月の経費</CardTitle>
            <p className="text-2xl font-bold">¥{summary.total.toLocaleString()}</p>
            <p className="text-xs text-stone-500">
              {summary.count}件
              {summary.voidedCount ? ` ・ 取消 ${summary.voidedCount}件` : ""}
            </p>
          </Card>
          <Card>
            <CardTitle>科目の内訳</CardTitle>
            {summary.byCategory.length ? (
              <ul className="text-sm">
                {summary.byCategory.slice(0, 5).map((c) => (
                  <li key={c.category} className="flex justify-between gap-2">
                    <span className="truncate">{c.category}</span>
                    <span className="font-semibold">¥{c.total.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-stone-400">まだありません</p>
            )}
          </Card>
        </div>

        <Card>
          <ManualExpenseForm today={jstToday()} />
        </Card>

        {list.length ? (
          <div className="space-y-2">
            {list.map((e) => (
              <ExpenseItem key={e.id} expense={e} />
            ))}
          </div>
        ) : (
          <EmptyState message="この月の経費はまだありません。上の「レシートを撮る」から登録できます。" />
        )}

        <p className="text-xs text-stone-400">
          登録した経費は取り消しても記録として残ります（削除しません）。日付・金額・支払先で
          検索できる形で保存しています。紙の原本を捨ててよいかは、税理士に確認してください。
        </p>
      </div>
    </>
  );
}
