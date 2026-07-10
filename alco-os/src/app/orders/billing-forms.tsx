"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { issueDocumentAction, voidDocumentAction, saveIssuerSettingsAction } from "./actions";
import type { Issuer } from "@/domain/billing/billing-service";

const inputClass = "w-full rounded-lg border border-stone-300 px-3 py-2 text-sm";
const buttonClass =
  "rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";

/** 注文カード内の帳票発行フォーム（納品書 / 請求書 / 領収書） */
export function IssueDocumentForm({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [docType, setDocType] = useState("delivery_note");
  const today = new Date().toLocaleDateString("sv-SE");

  return (
    <details className="mt-2 rounded-lg bg-stone-50 p-2">
      <summary className="cursor-pointer text-xs font-semibold text-green-700">
        🧾 帳票を発行（納品書・請求書・領収書）
      </summary>
      <form
        action={(formData) => {
          setError(null);
          startTransition(async () => {
            const result = await issueDocumentAction(formData);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            router.push(`/orders/documents/${result.data}`);
          });
        }}
        className="mt-2 space-y-2"
      >
        <input type="hidden" name="order_id" value={orderId} />
        <div className="flex flex-wrap gap-2">
          <select
            name="doc_type"
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            className={inputClass + " max-w-36"}
          >
            <option value="delivery_note">納品書</option>
            <option value="invoice">請求書</option>
            <option value="receipt">領収書</option>
          </select>
          <input
            name="issue_date"
            type="date"
            defaultValue={today}
            required
            className={inputClass + " max-w-40"}
          />
          <select name="tax_rate" defaultValue="8" className={inputClass + " max-w-36"}>
            <option value="8">内税8%（食品）</option>
            <option value="10">内税10%</option>
            <option value="0">非課税・税なし</option>
          </select>
          {docType === "invoice" ? (
            <label className="flex items-center gap-1 text-xs text-stone-500">
              支払期限
              <input name="due_date" type="date" className={inputClass + " max-w-40"} />
            </label>
          ) : null}
        </div>
        <input
          name="title"
          placeholder="ファイル名（空欄なら自動: 番号_顧客名_種類）"
          className={inputClass}
        />
        <input
          name="note"
          placeholder={
            docType === "receipt" ? "但し書き（空欄なら「ジビエ肉代として」）" : "備考（任意）"
          }
          className={inputClass}
        />
        <button type="submit" disabled={isPending} className={buttonClass}>
          {isPending ? "発行中…" : "発行してプレビュー"}
        </button>
        <p className="text-xs text-stone-400">
          番号は月ごとに自動採番されます（例: INV-202607-001）。発行後の内容は固定され、
          注文を変更しても帳票は変わりません。
        </p>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </form>
    </details>
  );
}

export function VoidDocumentButton({ docId }: { docId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <button
        onClick={() => {
          if (!confirm("この帳票を取消にしますか？（番号は欠番として残ります）")) return;
          startTransition(async () => {
            const result = await voidDocumentAction(docId);
            if (!result.ok) setError(result.error);
          });
        }}
        disabled={isPending}
        className="text-xs text-red-600 underline disabled:opacity-50"
      >
        取消
      </button>
      {error ? <span className="ml-1 text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

/** 発行者情報（org_settings 共用キー）の編集 */
export function IssuerSettingsForm({ issuer }: { issuer: Issuer }) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <details className="rounded-lg border border-stone-200 bg-white p-3">
      <summary className="cursor-pointer text-sm font-semibold text-stone-600">
        ⚙️ 帳票の発行者情報（社名・住所・インボイス登録番号・振込先）
      </summary>
      <form
        action={(formData) => {
          setMessage(null);
          startTransition(async () => {
            const result = await saveIssuerSettingsAction(formData);
            setMessage(result.ok ? "保存しました" : result.error);
          });
        }}
        className="mt-2 space-y-2"
      >
        <input name="org_name" defaultValue={issuer.name} placeholder="発行者名" className={inputClass} />
        <div className="flex gap-2">
          <input name="org_postal" defaultValue={issuer.postal} placeholder="郵便番号" className={inputClass + " max-w-32"} />
          <input name="org_address" defaultValue={issuer.address} placeholder="住所" className={inputClass} />
        </div>
        <div className="flex gap-2">
          <input name="org_phone" defaultValue={issuer.phone} placeholder="電話番号" className={inputClass + " max-w-44"} />
          <input
            name="invoice_number"
            defaultValue={issuer.registrationNumber}
            placeholder="インボイス登録番号（T+13桁。未登録なら空欄）"
            className={inputClass}
          />
        </div>
        <textarea
          name="org_bank_info"
          defaultValue={issuer.bankInfo}
          rows={2}
          placeholder="振込先（例: ◯◯銀行 ◯◯支店 普通 1234567 ゴウドウガイシャアルコ）— 請求書に印字"
          className={inputClass}
        />
        <button type="submit" disabled={isPending} className={buttonClass}>
          {isPending ? "保存中…" : "保存"}
        </button>
        {message ? <p className="text-sm text-stone-600">{message}</p> : null}
        <p className="text-xs text-stone-400">
          既存アプリ（ジビエ基幹）の設定と共用です。ここで直すと両方に反映されます。
        </p>
      </form>
    </details>
  );
}

/** 印刷（PDF保存）ボタン。帳票ページ用 */
export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className={buttonClass + " no-print w-full"}
      type="button"
    >
      📄 印刷 / PDFで保存
    </button>
  );
}
