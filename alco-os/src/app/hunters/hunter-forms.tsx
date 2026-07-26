"use client";

import { useState, useTransition } from "react";
import type { ActionResult, ActionResultWith } from "@/lib/action-result";
import {
  importProfilesCsvAction,
  revealBankAccountAction,
  saveBankAccountAction,
  saveHunterProfileAction,
} from "./actions";
import type { CsvRowResult } from "@/domain/hunters/hunter-profile-service";

/** 高齢者UI: ボタン56px以上・ラベルは何が起きるかを書く・色だけで示さない */
const BUTTON = "w-full min-h-[56px] rounded-xl px-4 text-base font-bold disabled:opacity-50";
const FIELD =
  "mt-1 w-full min-h-[56px] rounded-xl border-2 border-stone-300 bg-white px-3 text-base";

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="mt-2 rounded-lg bg-red-50 p-2 text-base font-bold text-red-700">⚠ {error}</p>
  );
}

export interface HunterRow {
  id: string;
  name: string;
  city: string | null;
  bankSummary: string;
  profile: {
    birthDate: string | null;
    postalCode: string | null;
    address: string | null;
    phone: string | null;
    activityArea: string | null;
    hasWorkerCard: boolean | null;
    workerCardNumber: string | null;
  } | null;
}

export function HunterCard({ hunter, canApprove }: { hunter: HunterRow; canApprove: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  const run = (fn: (fd: FormData) => Promise<ActionResult>, fd: FormData) => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await fn(fd);
      if (result.ok) setSaved(true);
      else setError(result.error);
    });
  };

  const p = hunter.profile;

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <p className="text-lg font-bold text-stone-800">
        {hunter.name}
        {hunter.city ? `（${hunter.city}）` : ""}
      </p>
      <p className="mt-1 text-base text-stone-700">
        <span aria-hidden="true">{p ? "✓" : "－"}</span>{" "}
        追加情報：{p ? "登録ずみ" : "未登録"}
      </p>
      <p className="text-base text-stone-700">
        <span aria-hidden="true">{hunter.bankSummary === "未登録" ? "－" : "✓"}</span>{" "}
        口座：{hunter.bankSummary}
      </p>

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`${BUTTON} mt-3 border-2 border-stone-400 bg-white text-stone-700`}
      >
        {open ? "▲ 入力を閉じる" : "▼ 追加情報・口座を入力する"}
      </button>

      {open ? (
        <div className="mt-3 space-y-4">
          <form
            action={(fd) => {
              fd.set("hunter_id", hunter.id);
              run(saveHunterProfileAction, fd);
            }}
            className="space-y-3"
          >
            <p className="text-base font-bold text-stone-700">追加情報（分かる範囲で結構です）</p>
            <label className="block">
              <span className="text-base text-stone-700">生年月日</span>
              <input type="date" name="birth_date" defaultValue={p?.birthDate ?? ""} className={FIELD} />
            </label>
            <label className="block">
              <span className="text-base text-stone-700">郵便番号</span>
              <input name="postal_code" defaultValue={p?.postalCode ?? ""} className={FIELD} />
            </label>
            <label className="block">
              <span className="text-base text-stone-700">住所</span>
              <input name="address" defaultValue={p?.address ?? ""} className={FIELD} />
            </label>
            <label className="block">
              <span className="text-base text-stone-700">電話番号</span>
              <input name="phone" defaultValue={p?.phone ?? ""} className={FIELD} />
            </label>
            <label className="block">
              <span className="text-base text-stone-700">活動エリア</span>
              <input name="activity_area" defaultValue={p?.activityArea ?? ""} className={FIELD} />
            </label>
            <label className="block">
              <span className="text-base text-stone-700">従事者証</span>
              <select
                name="has_worker_card"
                defaultValue={p?.hasWorkerCard === null || p?.hasWorkerCard === undefined ? "" : p.hasWorkerCard ? "あり" : "なし"}
                className={FIELD}
              >
                <option value="">わからない</option>
                <option value="あり">あり</option>
                <option value="なし">なし</option>
              </select>
            </label>
            <label className="block">
              <span className="text-base text-stone-700">従事者証番号</span>
              <input
                name="worker_card_number"
                defaultValue={p?.workerCardNumber ?? ""}
                className={FIELD}
              />
            </label>
            <button type="submit" disabled={isPending} className={`${BUTTON} bg-green-700 text-white`}>
              ✓ 追加情報を保存する
            </button>
          </form>

          <form
            action={(fd) => {
              fd.set("hunter_id", hunter.id);
              run(saveBankAccountAction, fd);
            }}
            className="space-y-3 rounded-xl bg-amber-50 p-3"
          >
            <p className="text-base font-bold text-amber-900">
              口座（電話・対面で聞き取った内容を入れてください）
            </p>
            <p className="text-base text-amber-900">
              ⚠ 口座番号はLINEで受け取らない決まりです。捕獲者から送られてきた場合も、
              ここに入力したうえでトークからは触れないでください。
            </p>
            {!canApprove ? (
              <p className="text-base font-bold text-stone-700">
                口座の登録・表示には承認権限が必要です。
              </p>
            ) : (
              <>
                <label className="block">
                  <span className="text-base text-stone-700">銀行名</span>
                  <input name="bank_name" className={FIELD} />
                </label>
                <label className="block">
                  <span className="text-base text-stone-700">支店名</span>
                  <input name="bank_branch" className={FIELD} />
                </label>
                <label className="block">
                  <span className="text-base text-stone-700">種別</span>
                  <select name="account_type" className={FIELD}>
                    <option value="普通">普通</option>
                    <option value="当座">当座</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-base text-stone-700">口座番号</span>
                  <input name="account_number" inputMode="numeric" className={FIELD} />
                </label>
                <label className="block">
                  <span className="text-base text-stone-700">口座名義（カナ）</span>
                  <input name="account_holder" className={FIELD} />
                </label>
                <button
                  type="submit"
                  disabled={isPending}
                  className={`${BUTTON} bg-green-700 text-white`}
                >
                  ✓ 口座を保存する
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    setError(null);
                    startTransition(async () => {
                      const result: ActionResultWith<{
                        accountNumber: string;
                        accountHolder: string;
                      }> = await revealBankAccountAction(hunter.id);
                      if (result.ok) {
                        setRevealed(`${result.data.accountNumber}（${result.data.accountHolder}）`);
                      } else {
                        setError(result.error);
                      }
                    });
                  }}
                  className={`${BUTTON} border-2 border-stone-400 bg-white text-stone-700`}
                >
                  👁 口座番号をすべて表示する（記録が残ります）
                </button>
                {revealed ? (
                  <p className="rounded-lg bg-white p-2 text-base font-bold text-stone-800">
                    {revealed}
                  </p>
                ) : null}
              </>
            )}
          </form>

          {saved ? (
            <p className="rounded-lg bg-green-50 p-2 text-base font-bold text-green-800">
              ✓ 保存しました
            </p>
          ) : null}
          <ErrorText error={error} />
        </div>
      ) : null}
    </div>
  );
}

/** CSVの一括取り込み（206名分の追加情報を入れる用途） */
export function CsvImportForm({ template }: { template: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<CsvRowResult[] | null>(null);
  const [savedCount, setSavedCount] = useState(0);

  return (
    <form
      action={(fd) => {
        setError(null);
        setResults(null);
        startTransition(async () => {
          const result = await importProfilesCsvAction(fd);
          if (result.ok) {
            setResults(result.data.results);
            setSavedCount(result.data.savedCount);
          } else {
            setError(result.error);
          }
        });
      }}
      className="space-y-3"
    >
      <p className="text-base text-stone-700">
        1行目は見出し行にしてください。口座はこのCSVでは取り込みません。
      </p>
      <pre className="overflow-x-auto rounded-lg bg-stone-100 p-3 text-sm">{template}</pre>
      <label className="block">
        <span className="text-base font-bold text-stone-700">CSVの中身を貼り付け</span>
        <textarea name="csv_text" rows={6} className="mt-1 w-full rounded-xl border-2 border-stone-300 p-3 text-base" />
      </label>
      <button type="submit" disabled={isPending} className={`${BUTTON} bg-green-700 text-white`}>
        ⬆ 取り込む
      </button>
      {results ? (
        <div className="rounded-xl bg-stone-50 p-3">
          <p className="text-base font-bold text-stone-800">
            ✓ {savedCount}件を登録しました（全{results.length}行）
          </p>
          <ul className="mt-2 space-y-1 text-base text-stone-700">
            {results
              .filter((r) => r.status === "skipped")
              .map((r) => (
                <li key={r.line}>
                  <span aria-hidden="true">！</span> {r.line}行目 {r.hunterName}：{r.reason}
                </li>
              ))}
          </ul>
        </div>
      ) : null}
      <ErrorText error={error} />
    </form>
  );
}
