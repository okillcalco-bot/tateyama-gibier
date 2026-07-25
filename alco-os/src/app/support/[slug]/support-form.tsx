"use client";

import { useState, useTransition } from "react";
import { SUPPORT_METHODS } from "@/domain/satoyama/funding-service";
import { submitPledgeAction } from "./actions";

const inputClass = "w-full rounded-lg border border-stone-300 px-3 py-3 text-base";

const PRESET_AMOUNTS = [
  { yen: 1000, label: "¥1,000", note: "調査1回の交通費に" },
  { yen: 3000, label: "¥3,000", note: "半日の調査の一部に" },
  { yen: 5000, label: "¥5,000", note: "1日の調査謝金の一部に" },
  { yen: 10000, label: "¥10,000", note: "1日の調査をまるごと" },
];

/** 応援フォーム（ログイン不要・外部の方向け） */
export function SupportForm({ slug, bankInfo }: { slug: string; bankInfo: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [amount, setAmount] = useState(3000);

  if (done) {
    return (
      <div className="rounded-xl border border-green-600 bg-green-50 p-4">
        <p className="text-base font-bold text-green-900">
          🌱 応援ありがとうございます！
        </p>
        <p className="mt-2 text-sm text-green-900">
          お申し込みを受け付けました。下記のお支払い方法でお手続きください。
          入金を確認しましたら、このクエストの応援メーターに反映されます。
        </p>
        {bankInfo ? (
          <div className="mt-2 rounded-lg bg-white p-2 text-sm">
            <p className="text-xs font-semibold text-stone-500">お振込先</p>
            <p className="whitespace-pre-wrap">{bankInfo}</p>
          </div>
        ) : (
          <p className="mt-2 text-sm">お振込先は折り返しご連絡します。</p>
        )}
        <p className="mt-2 text-xs text-green-800">
          調査が進んだら、このページの進捗メーターと成果報告が更新されます。ぜひ見に来てください。
        </p>
      </div>
    );
  }

  return (
    <form
      action={(formData) => {
        setError(null);
        startTransition(async () => {
          const result = await submitPledgeAction(formData);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setDone(true);
        });
      }}
      className="space-y-3"
    >
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="amount_yen" value={amount} />

      <div>
        <p className="mb-1 text-sm font-semibold">応援する金額</p>
        <div className="grid grid-cols-2 gap-2">
          {PRESET_AMOUNTS.map((preset) => (
            <button
              key={preset.yen}
              type="button"
              onClick={() => setAmount(preset.yen)}
              className={`min-h-14 rounded-xl border px-3 py-2 text-left ${
                amount === preset.yen
                  ? "border-green-700 bg-green-700 text-white"
                  : "border-stone-300 bg-white"
              }`}
            >
              <span className="block text-base font-bold">{preset.label}</span>
              <span className={`block text-xs ${amount === preset.yen ? "text-green-50" : "text-stone-500"}`}>
                {preset.note}
              </span>
            </button>
          ))}
        </div>
        <input
          type="number"
          min="100"
          step="100"
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          className={inputClass + " mt-2"}
          aria-label="金額を自由に入力"
        />
      </div>

      <input name="display_name" placeholder="お名前（公開されます。匿名可）" className={inputClass} />
      <input name="email" type="email" placeholder="メールアドレス（ご連絡用・非公開）" className={inputClass} />
      <textarea name="message" rows={2} placeholder="応援メッセージ（任意）" className={inputClass} />

      <select name="method" className={inputClass}>
        {Object.entries(SUPPORT_METHODS)
          .filter(([key]) => key !== "stripe")
          .map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
      </select>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="is_public" defaultChecked />
        お名前をこのページに掲載してよい
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="message_public" defaultChecked />
        メッセージを掲載してよい
      </label>

      <button
        type="submit"
        disabled={isPending}
        className="min-h-14 w-full rounded-xl bg-green-700 px-4 py-3 text-lg font-bold text-white disabled:opacity-50"
      >
        {isPending ? "送信中…" : `¥${amount.toLocaleString()} で応援する`}
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <p className="text-xs text-stone-500">
        送信後にお支払い方法をご案内します。クレジットカード決済は準備中のため、
        現在は銀行振込・現地でのお支払いのみです。
      </p>
    </form>
  );
}
