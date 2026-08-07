"use client";

import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";
import { EXPENSE_CATEGORIES, EXPENSE_PAYMENT_METHODS } from "@/domain/accounting/expense-service";
import {
  uploadReceiptAction,
  confirmExpenseAction,
  discardReceiptAction,
  updateExpenseAction,
  voidExpenseAction,
} from "./actions";

/**
 * 経費（レシート）の入力フォーム。
 * 現場・移動中にスマホで撮る前提。ボタンは大きく、押した後の状態を文字で出す。
 */

const BUTTON = "w-full min-h-[56px] rounded-xl px-4 text-base font-bold disabled:opacity-50";
const FIELD =
  "mt-1 w-full min-h-[48px] rounded-xl border-2 border-stone-300 bg-white px-3 text-base";
const LABEL = "block text-sm font-semibold text-stone-700";

function useAction() {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult>, onDone?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) onDone?.();
      else setError(result.error);
    });
  };
  return { isPending, error, run };
}

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="mt-2 rounded-lg bg-red-50 p-2 text-base font-bold text-red-700">⚠ {error}</p>
  );
}

/** ① レシートを撮る（AIが読む） */
export function ReceiptUploadForm() {
  const { isPending, error, run } = useAction();
  const [fileName, setFileName] = useState<string | null>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const formData = new FormData(form);
        run(
          () => uploadReceiptAction(formData),
          () => {
            form.reset();
            setFileName(null);
          },
        );
      }}
    >
      <label className={`${BUTTON} flex items-center justify-center bg-green-700 text-white`}>
        📷 レシートを撮る / 選ぶ
        <input
          type="file"
          name="photo"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          required
        />
      </label>
      {fileName ? <p className="mt-2 text-sm text-stone-600">選択中: {fileName}</p> : null}

      <label className={`${LABEL} mt-3`}>
        ひとことメモ（任意）
        <input
          name="hint"
          className={FIELD}
          placeholder="例: 軽トラの燃料 / 解体室の消耗品"
        />
      </label>

      <button
        type="submit"
        disabled={isPending}
        className={`${BUTTON} mt-3 border-2 border-green-700 text-green-800`}
      >
        {isPending ? "読み取り中…（10秒ほどかかります）" : "この写真を読み取る"}
      </button>
      <ErrorText error={error} />
      <p className="mt-2 text-sm text-stone-500">
        読み取った内容は下に「確認待ち」として出ます。<strong>登録するのは自分で確認してから</strong>です。
      </p>
    </form>
  );
}

export interface ReceiptSuggestion {
  draftId: string;
  photoUrl: string | null;
  expenseDate: string;
  amount: number | null;
  vendor: string;
  category: string;
  paymentMethod: string;
  taxRate: number | null;
  taxAmount: number | null;
  invoiceNumber: string;
  note: string;
  uncertainFields: string[];
  items: { name: string; amount: number | null }[];
}

const FIELD_LABELS: Record<string, string> = {
  expense_date: "日付",
  amount: "金額",
  vendor: "支払先",
  category: "科目",
  payment_method: "支払方法",
  tax_rate: "税率",
  tax_amount: "消費税",
  invoice_number: "インボイス番号",
};

/** ② 読み取り結果を確認して登録する */
export function ReceiptConfirmForm({ suggestion }: { suggestion: ReceiptSuggestion }) {
  const { isPending, error, run } = useAction();
  const uncertain = new Set(suggestion.uncertainFields);
  const mark = (key: string) =>
    uncertain.has(key) ? "border-amber-500 bg-amber-50" : "border-stone-300 bg-white";

  return (
    <div className="rounded-xl border-2 border-amber-400 bg-white p-3">
      <div className="flex items-start gap-3">
        {suggestion.photoUrl ? (
          // 署名URL（1時間で失効）。next/image は外部署名URLに設定が必要なため img を使う
          // eslint-disable-next-line @next/next/no-img-element
          <a href={suggestion.photoUrl} target="_blank" rel="noreferrer" className="shrink-0">
            <img
              src={suggestion.photoUrl}
              alt="レシート"
              className="h-28 w-20 rounded-lg border border-stone-200 object-cover"
            />
          </a>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold text-amber-800">確認待ち（AIの読み取り結果）</p>
          {uncertain.size > 0 ? (
            <p className="mt-1 text-sm text-amber-800">
              ⚠ 自信がない項目:{" "}
              {[...uncertain].map((k) => FIELD_LABELS[k] ?? k).join("・")}（黄色の欄）
            </p>
          ) : null}
          {suggestion.items.length > 0 ? (
            <ul className="mt-1 text-xs text-stone-500">
              {suggestion.items.slice(0, 5).map((item, i) => (
                <li key={i}>
                  {item.name}
                  {item.amount !== null ? ` ¥${item.amount.toLocaleString()}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <form
        className="mt-3 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const formData = new FormData(e.currentTarget);
          run(() => confirmExpenseAction(formData));
        }}
      >
        <input type="hidden" name="draft_id" value={suggestion.draftId} />
        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>
            日付
            <input
              type="date"
              name="expense_date"
              defaultValue={suggestion.expenseDate}
              required
              className={`${FIELD} ${mark("expense_date")}`}
            />
          </label>
          <label className={LABEL}>
            金額（税込）
            <input
              type="number"
              name="amount"
              inputMode="numeric"
              defaultValue={suggestion.amount ?? ""}
              required
              className={`${FIELD} ${mark("amount")}`}
            />
          </label>
        </div>
        <label className={LABEL}>
          支払先（店名）
          <input
            name="vendor"
            defaultValue={suggestion.vendor}
            required
            className={`${FIELD} ${mark("vendor")}`}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>
            科目
            <select
              name="category"
              defaultValue={suggestion.category}
              className={`${FIELD} ${mark("category")}`}
            >
              <option value="">（未分類）</option>
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className={LABEL}>
            支払方法
            <select
              name="payment_method"
              defaultValue={suggestion.paymentMethod}
              className={`${FIELD} ${mark("payment_method")}`}
            >
              <option value="">（未選択）</option>
              {EXPENSE_PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>
            税率（%）
            <input
              type="number"
              name="tax_rate"
              defaultValue={suggestion.taxRate ?? ""}
              className={`${FIELD} ${mark("tax_rate")}`}
            />
          </label>
          <label className={LABEL}>
            消費税額
            <input
              type="number"
              name="tax_amount"
              defaultValue={suggestion.taxAmount ?? ""}
              className={`${FIELD} ${mark("tax_amount")}`}
            />
          </label>
        </div>
        <label className={LABEL}>
          インボイス登録番号（T+13桁・無ければ空）
          <input
            name="invoice_number"
            defaultValue={suggestion.invoiceNumber}
            className={`${FIELD} ${mark("invoice_number")}`}
          />
        </label>
        <label className={LABEL}>
          メモ
          <input name="note" defaultValue={suggestion.note} className={`${FIELD} border-stone-300`} />
        </label>

        <button type="submit" disabled={isPending} className={`${BUTTON} bg-green-700 text-white`}>
          {isPending ? "登録中…" : "✅ この内容で登録する"}
        </button>
        <ErrorText error={error} />
      </form>

      <DiscardReceiptButton draftId={suggestion.draftId} />
    </div>
  );
}

function DiscardReceiptButton({ draftId }: { draftId: string }) {
  const { isPending, error, run } = useAction();
  return (
    <div className="mt-2">
      <button
        type="button"
        disabled={isPending}
        onClick={() => {
          if (!confirm("この読み取り結果を使わずに消しますか？（写真は残ります）")) return;
          run(() => discardReceiptAction(draftId));
        }}
        className="w-full min-h-[44px] rounded-xl border-2 border-stone-300 text-sm font-semibold text-stone-600"
      >
        使わない（読み取り失敗・重複）
      </button>
      <ErrorText error={error} />
    </div>
  );
}

/** ③ 手入力（写真がない・AIが読めなかったとき） */
export function ManualExpenseForm({ today }: { today: string }) {
  const { isPending, error, run } = useAction();
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${BUTTON} border-2 border-stone-300 text-stone-700`}
      >
        ✏️ 写真なしで手入力する
      </button>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const formData = new FormData(form);
        run(
          () => confirmExpenseAction(formData),
          () => form.reset(),
        );
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <label className={LABEL}>
          日付
          <input type="date" name="expense_date" defaultValue={today} required className={FIELD} />
        </label>
        <label className={LABEL}>
          金額（税込）
          <input type="number" name="amount" inputMode="numeric" required className={FIELD} />
        </label>
      </div>
      <label className={LABEL}>
        支払先（店名）
        <input name="vendor" required className={FIELD} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className={LABEL}>
          科目
          <select name="category" className={FIELD}>
            <option value="">（未分類）</option>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          支払方法
          <select name="payment_method" className={FIELD}>
            <option value="">（未選択）</option>
            {EXPENSE_PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={LABEL}>
        メモ
        <input name="note" className={FIELD} />
      </label>
      <button type="submit" disabled={isPending} className={`${BUTTON} bg-green-700 text-white`}>
        {isPending ? "登録中…" : "登録する"}
      </button>
      <ErrorText error={error} />
    </form>
  );
}

export interface ExpenseRow {
  id: string;
  expenseDate: string;
  amount: number;
  vendor: string;
  category: string;
  paymentMethod: string;
  invoiceNumber: string;
  note: string;
  corrected: boolean;
  voided: boolean;
  photoUrl: string | null;
}

/** ④ 登録済みの1件（開くと修正・取消できる） */
export function ExpenseItem({ expense }: { expense: ExpenseRow }) {
  const { isPending, error, run } = useAction();

  return (
    <details className={`rounded-xl border p-3 ${expense.voided ? "border-stone-200 bg-stone-50" : "border-stone-200 bg-white"}`}>
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-stone-500">{expense.expenseDate}</span>
          <span className={`font-bold ${expense.voided ? "line-through opacity-60" : ""}`}>
            ¥{expense.amount.toLocaleString()}
          </span>
          <span className={expense.voided ? "line-through opacity-60" : ""}>{expense.vendor}</span>
          {expense.category ? (
            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs">{expense.category}</span>
          ) : (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">未分類</span>
          )}
          {expense.voided ? (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">取消済</span>
          ) : null}
        </div>
      </summary>

      {expense.voided ? (
        <p className="mt-2 text-sm text-stone-500">{expense.note}</p>
      ) : (
        <>
          {expense.photoUrl ? (
            <a
              href={expense.photoUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-sm font-semibold text-green-700 underline"
            >
              レシートの写真を開く
            </a>
          ) : (
            <p className="mt-2 text-sm text-stone-400">写真なし（手入力）</p>
          )}

          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const formData = new FormData(e.currentTarget);
              run(() => updateExpenseAction(formData));
            }}
          >
            <input type="hidden" name="id" value={expense.id} />
            <div className="grid grid-cols-2 gap-3">
              <label className={LABEL}>
                日付
                <input
                  type="date"
                  name="expense_date"
                  defaultValue={expense.expenseDate}
                  required
                  className={FIELD}
                />
              </label>
              <label className={LABEL}>
                金額（税込）
                <input
                  type="number"
                  name="amount"
                  defaultValue={expense.amount}
                  required
                  className={FIELD}
                />
              </label>
            </div>
            <label className={LABEL}>
              支払先
              <input name="vendor" defaultValue={expense.vendor} required className={FIELD} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className={LABEL}>
                科目
                <select name="category" defaultValue={expense.category} className={FIELD}>
                  <option value="">（未分類）</option>
                  {EXPENSE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className={LABEL}>
                支払方法
                <select
                  name="payment_method"
                  defaultValue={expense.paymentMethod}
                  className={FIELD}
                >
                  <option value="">（未選択）</option>
                  {EXPENSE_PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className={LABEL}>
              インボイス登録番号
              <input
                name="invoice_number"
                defaultValue={expense.invoiceNumber}
                className={FIELD}
              />
            </label>
            <label className={LABEL}>
              メモ
              <input name="note" defaultValue={expense.note} className={FIELD} />
            </label>
            <button
              type="submit"
              disabled={isPending}
              className={`${BUTTON} border-2 border-green-700 text-green-800`}
            >
              {isPending ? "保存中…" : "修正を保存する"}
            </button>
          </form>

          <form
            className="mt-2"
            onSubmit={(e) => {
              e.preventDefault();
              const formData = new FormData(e.currentTarget);
              if (!confirm("この経費を取り消しますか？（記録は残ります）")) return;
              run(() => voidExpenseAction(formData));
            }}
          >
            <input type="hidden" name="id" value={expense.id} />
            <input
              name="reason"
              placeholder="取消の理由（重複・誤登録 など）"
              className={`${FIELD} border-red-200`}
            />
            <button
              type="submit"
              disabled={isPending}
              className={`${BUTTON} mt-2 border-2 border-red-300 text-red-700`}
            >
              取り消す（消さずに残す）
            </button>
          </form>
          <ErrorText error={error} />
        </>
      )}
    </details>
  );
}
