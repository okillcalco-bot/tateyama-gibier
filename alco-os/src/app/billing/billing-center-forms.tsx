"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui";
import { DOC_TYPES, CONVERT_TARGETS, type DocType } from "@/domain/billing/billing-service";
import {
  createManualDocumentAction,
  convertDocumentAction,
  voidDocumentFromBillingAction,
  importMisocaCsvAction,
} from "./actions";

const inputClass = "w-full rounded-lg border border-stone-300 px-3 py-2 text-sm";
const buttonClass =
  "rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";

interface ItemRow {
  name: string;
  qty: string;
  price: string;
  amount: string;
}
const emptyRow = (): ItemRow => ({ name: "", qty: "", price: "", amount: "" });

export interface CustomerOption {
  id: string;
  name: string;
  address: string;
}

/** Misoca型の新規帳票フォーム（見積・納品・請求・領収を1画面で） */
export function NewDocumentForm({ customers }: { customers: CustomerOption[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [docType, setDocType] = useState<DocType>("quote");
  const [customerName, setCustomerName] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [rows, setRows] = useState<ItemRow[]>([emptyRow(), emptyRow(), emptyRow()]);
  const today = new Date().toLocaleDateString("sv-SE");

  const setRow = (i: number, patch: Partial<ItemRow>) => {
    setRows((prev) =>
      prev.map((row, idx) => {
        if (idx !== i) return row;
        const next = { ...row, ...patch };
        // 数量×単価が両方入っていれば金額を自動計算（手入力で上書き可）
        if (("qty" in patch || "price" in patch) && next.qty && next.price) {
          const qty = Number(next.qty);
          const price = Number(next.price);
          if (Number.isFinite(qty) && Number.isFinite(price)) {
            next.amount = String(Math.round(qty * price));
          }
        }
        return next;
      }),
    );
  };
  const total = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const dueLabel = docType === "quote" ? "有効期限" : docType === "invoice" ? "支払期限" : "";

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={buttonClass + " min-h-12 w-full"}>
        ＋ 帳票を作成（見積書・納品書・請求書・領収書）
      </button>
    );
  }
  return (
    <Card>
      <form
        action={(formData) => {
          setError(null);
          startTransition(async () => {
            const result = await createManualDocumentAction(formData);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            router.push(`/orders/documents/${result.data}`);
          });
        }}
        className="space-y-3"
      >
        <div className="flex flex-wrap gap-2">
          {(Object.entries(DOC_TYPES) as [DocType, { label: string }][]).map(([key, def]) => (
            <button
              key={key}
              type="button"
              onClick={() => setDocType(key)}
              className={`min-h-11 rounded-xl border px-4 text-sm font-semibold ${
                docType === key
                  ? "border-green-700 bg-green-700 text-white"
                  : "border-stone-300 bg-white text-stone-600"
              }`}
            >
              {def.label}
            </button>
          ))}
        </div>
        <input type="hidden" name="doc_type" value={docType} />

        <div className="flex flex-wrap gap-2">
          <select
            className={inputClass + " max-w-56"}
            value=""
            onChange={(e) => {
              const c = customers.find((x) => x.id === e.target.value);
              if (c) {
                setCustomerName(c.name);
                setCustomerAddress(c.address);
              }
            }}
          >
            <option value="">既存顧客から選ぶ（任意）</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            name="customer_name"
            required
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            placeholder="宛名（会社名・氏名）"
            className={inputClass}
          />
        </div>
        <input
          name="customer_address"
          value={customerAddress}
          onChange={(e) => setCustomerAddress(e.target.value)}
          placeholder="宛先住所（任意）"
          className={inputClass}
        />

        <div>
          <p className="mb-1 text-xs font-semibold text-stone-500">明細</p>
          <div className="space-y-1">
            {rows.map((row, i) => (
              <div key={i} className="flex gap-1">
                <input
                  name={`item_name_${i}`}
                  value={row.name}
                  onChange={(e) => setRow(i, { name: e.target.value })}
                  placeholder="品目"
                  className={inputClass}
                />
                <input
                  name={`item_qty_${i}`}
                  value={row.qty}
                  onChange={(e) => setRow(i, { qty: e.target.value })}
                  placeholder="数量"
                  className={inputClass + " max-w-16 px-2"}
                  inputMode="decimal"
                />
                <input
                  name={`item_price_${i}`}
                  value={row.price}
                  onChange={(e) => setRow(i, { price: e.target.value })}
                  placeholder="単価"
                  className={inputClass + " max-w-20 px-2"}
                  inputMode="numeric"
                />
                <input
                  name={`item_amount_${i}`}
                  value={row.amount}
                  onChange={(e) => setRow(i, { amount: e.target.value })}
                  placeholder="金額"
                  className={inputClass + " max-w-24 px-2 font-semibold"}
                  inputMode="numeric"
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setRows((prev) => [...prev, emptyRow()])}
              className="text-xs text-green-700 underline"
            >
              ＋ 行を追加
            </button>
            <p className="text-sm font-bold">合計（税込） ¥{total.toLocaleString()}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input name="issue_date" type="date" defaultValue={today} required className={inputClass + " max-w-40"} />
          <select name="tax_rate" defaultValue="8" className={inputClass + " max-w-36"}>
            <option value="8">内税8%（食品）</option>
            <option value="10">内税10%</option>
            <option value="0">非課税・税なし</option>
          </select>
          {dueLabel ? (
            <label className="flex items-center gap-1 text-xs text-stone-500">
              {dueLabel}
              <input name="due_date" type="date" className={inputClass + " max-w-40"} />
            </label>
          ) : null}
        </div>
        <input name="title" placeholder="ファイル名（空欄なら自動: 番号_宛名_種類）" className={inputClass} />
        <input
          name="note"
          placeholder={docType === "receipt" ? "但し書き（空欄なら「ジビエ肉代として」）" : "備考（任意）"}
          className={inputClass}
        />

        <div className="flex gap-2">
          <button type="submit" disabled={isPending} className={buttonClass + " min-h-12 flex-1"}>
            {isPending ? "発行中…" : `${DOC_TYPES[docType].label}を発行してプレビュー`}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg border border-stone-300 px-4 py-2 text-sm text-stone-600"
          >
            閉じる
          </button>
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </form>
    </Card>
  );
}

/** 書類変換ボタン（見積→納品/請求、納品→請求、請求→領収） */
export function ConvertButtons({ docId, docType }: { docId: string; docType: DocType }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const targets = CONVERT_TARGETS[docType] ?? [];
  if (!targets.length) return null;

  return (
    <span className="inline-flex items-center gap-1">
      {targets.map((target) => (
        <button
          key={target}
          disabled={isPending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await convertDocumentAction(docId, target);
              if (!result.ok) {
                setError(result.error);
                return;
              }
              router.push(`/orders/documents/${result.data}`);
            });
          }}
          className="rounded-lg border border-green-700 px-2 py-1 text-xs font-semibold text-green-700 disabled:opacity-50"
        >
          →{DOC_TYPES[target].label}
        </button>
      ))}
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

export function VoidDocButton({ docId }: { docId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <button
        onClick={() => {
          if (!confirm("この帳票を取消にしますか？（番号は欠番として残ります）")) return;
          startTransition(async () => {
            const result = await voidDocumentFromBillingAction(docId);
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

/** Misoca CSVインポート */
export function MisocaImportForm() {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <details className="rounded-lg border border-stone-200 bg-white p-3">
      <summary className="cursor-pointer text-sm font-semibold text-stone-600">
        📥 Misocaからデータを移行する（CSVインポート）
      </summary>
      <div className="mt-2 space-y-2 text-sm">
        <ol className="list-decimal pl-5 text-xs text-stone-500">
          <li>Misoca（app.misoca.jp）にログイン → 請求書（見積書/納品書）の一覧画面</li>
          <li>一覧の「CSVダウンロード」でエクスポート（書類の種類ごとに1ファイル）</li>
          <li>下で書類の種類を選んでファイルをアップロード（何回でも可・重複は自動スキップ）</li>
        </ol>
        <form
          action={(formData) => {
            setError(null);
            setMessage(null);
            startTransition(async () => {
              const result = await importMisocaCsvAction(formData);
              if (!result.ok) {
                setError(result.error);
                return;
              }
              const { imported, duplicates, skipped } = result.data;
              setMessage(
                `${imported}件を取り込みました（重複スキップ ${duplicates}件・読めない行 ${skipped}件）`,
              );
            });
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <select name="doc_type" className={inputClass + " max-w-36"}>
            <option value="invoice">請求書</option>
            <option value="quote">見積書</option>
            <option value="delivery_note">納品書</option>
            <option value="receipt">領収書</option>
          </select>
          <input name="csv" type="file" accept=".csv,text/csv" required className="text-sm" />
          <button type="submit" disabled={isPending} className={buttonClass}>
            {isPending ? "取り込み中…" : "インポート"}
          </button>
        </form>
        {message ? <p className="font-semibold text-green-700">✓ {message}</p> : null}
        {error ? <p className="text-red-600">{error}</p> : null}
        <p className="text-xs text-stone-400">
          金額・番号はMisocaの値をそのまま保存します（再計算しません）。
          一覧CSVには明細行が含まれないため、明細は件名1行になります。原本PDFはMisocaで保管を。
        </p>
      </div>
    </details>
  );
}
