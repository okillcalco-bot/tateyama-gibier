import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { DOC_TYPES, type DocType, type DocumentItem, type Issuer } from "@/domain/billing/billing-service";
import { PrintButton } from "../../billing-forms";

export const dynamic = "force-dynamic";

/**
 * 帳票の印刷ページ（請求書 / 納品書 / 領収書）。
 * ブラウザの「印刷 → PDFに保存」でPDF化する。<title> を帳票のファイル名に
 * しているので、PDF保存時の既定ファイル名がそのまま任意の名前になる。
 */

async function fetchDoc(id: string) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from("billing_documents").select("*").eq("id", id).maybeSingle();
  return data;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  if (!isSupabaseConfigured()) return { title: "帳票" };
  const doc = await fetchDoc(id);
  return { title: (doc?.title as string) ?? "帳票" };
}

const yen = (n: number) => `¥${Math.round(n).toLocaleString()}`;

export default async function BillingDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isSupabaseConfigured()) notFound();
  const doc = await fetchDoc(id);
  if (!doc) notFound();

  const docType = doc.doc_type as DocType;
  const label = DOC_TYPES[docType]?.label ?? "帳票";
  const items = (doc.items ?? []) as DocumentItem[];
  const issuer = (doc.issuer ?? {}) as Partial<Issuer>;
  const isReceipt = docType === "receipt";
  const voided = Boolean(doc.deleted_at);

  return (
    <div className="billing-doc mx-auto max-w-2xl">
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 16mm; }
          aside, .billing-hide-print, nav, body > div > div > header { display: none !important; }
          main { padding: 0 !important; }
          .billing-doc { max-width: none; }
          body { background: #fff !important; }
        }
        .billing-paper { background: #fff; border: 1px solid #e7e5e4; padding: 24px; }
        @media print { .billing-paper { border: none; padding: 0; } }
        .billing-paper table { border-collapse: collapse; width: 100%; }
        .billing-paper th, .billing-paper td { border: 1px solid #57534e; padding: 6px 8px; font-size: 13px; }
        .billing-paper th { background: #f5f5f4; font-weight: 600; }
        @media print { .billing-paper th { background: #eee !important; } }
      `}</style>

      <div className="billing-hide-print no-print mb-3 space-y-2">
        <Link href="/orders" className="text-sm text-green-700 underline">← 受注管理へ戻る</Link>
        {voided ? (
          <p className="rounded-lg bg-red-50 p-2 text-sm font-semibold text-red-700">
            ⚠ この帳票は取消済みです（番号 {doc.doc_number as string} は欠番）
          </p>
        ) : null}
        <PrintButton />
        <p className="text-xs text-stone-400">
          PDF保存時のファイル名: {doc.title as string}
        </p>
      </div>

      <div className="billing-paper">
        <h1 className="mb-1 text-center text-2xl font-bold tracking-[0.5em]">{label}</h1>
        <div className="mb-4 flex items-end justify-between text-sm">
          <div>
            <p className="text-lg font-semibold">
              {(doc.customer_name as string) || "　"}　{doc.honorific as string}
            </p>
            {doc.customer_address ? (
              <p className="text-xs text-stone-600">{doc.customer_address as string}</p>
            ) : null}
          </div>
          <div className="text-right text-xs">
            <p>No. {doc.doc_number as string}</p>
            <p>発行日: {doc.issue_date as string}</p>
            {docType === "invoice" && doc.due_date ? <p>お支払期限: {doc.due_date as string}</p> : null}
            {docType === "quote" && doc.due_date ? <p>お見積有効期限: {doc.due_date as string}</p> : null}
          </div>
        </div>

        {isReceipt ? (
          <div className="mb-4">
            <p className="mx-auto w-fit border-b-4 border-double border-stone-700 px-10 py-2 text-center text-2xl font-bold">
              {yen(Number(doc.total))} −
            </p>
            <p className="mt-2 text-center text-xs text-stone-600">
              （内消費税{doc.tax_rate as number}% {yen(Number(doc.tax_amount))}）
            </p>
            {doc.note ? <p className="mt-3 text-center text-sm">{doc.note as string}</p> : null}
          </div>
        ) : (
          <>
            <p className="mb-2 text-sm">
              {docType === "invoice"
                ? "下記のとおりご請求申し上げます。"
                : docType === "quote"
                  ? "下記のとおりお見積り申し上げます。"
                  : "下記のとおり納品いたしました。"}
            </p>
            <p className="mb-3 text-lg font-bold">
              合計金額　{yen(Number(doc.total))} <span className="text-xs font-normal">（税込）</span>
            </p>
            <table className="mb-3">
              <thead>
                <tr>
                  <th className="text-left">品目</th>
                  <th className="w-20">数量</th>
                  <th className="w-24">単価</th>
                  <th className="w-28">金額</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, i) => (
                  <tr key={i}>
                    <td>{item.name}</td>
                    <td className="text-right">{item.quantity}</td>
                    <td className="text-right">{item.unit_price !== null ? yen(item.unit_price) : "—"}</td>
                    <td className="text-right">{yen(item.amount)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3} className="text-right">小計（税抜相当）</td>
                  <td className="text-right">{yen(Number(doc.subtotal))}</td>
                </tr>
                <tr>
                  <td colSpan={3} className="text-right">
                    消費税（{doc.tax_rate as number}%{Number(doc.tax_rate) === 8 ? "・軽減税率" : ""}）
                  </td>
                  <td className="text-right">{yen(Number(doc.tax_amount))}</td>
                </tr>
                <tr>
                  <td colSpan={3} className="text-right font-bold">合計（税込）</td>
                  <td className="text-right font-bold">{yen(Number(doc.total))}</td>
                </tr>
              </tbody>
            </table>
            {docType === "invoice" && issuer.bankInfo ? (
              <div className="mb-3 border border-stone-500 p-2 text-sm">
                <p className="text-xs font-semibold">お振込先</p>
                <p className="whitespace-pre-wrap">{issuer.bankInfo}</p>
              </div>
            ) : null}
            {doc.note ? <p className="mb-3 text-sm">備考: {doc.note as string}</p> : null}
          </>
        )}

        <div className="mt-6 flex justify-end">
          <div className="text-right text-sm">
            <p className="font-semibold">{issuer.name ?? ""}</p>
            {issuer.postal || issuer.address ? (
              <p className="text-xs">〒{issuer.postal} {issuer.address}</p>
            ) : null}
            {issuer.phone ? <p className="text-xs">TEL {issuer.phone}</p> : null}
            {issuer.registrationNumber ? (
              <p className="text-xs">登録番号 {issuer.registrationNumber}</p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
