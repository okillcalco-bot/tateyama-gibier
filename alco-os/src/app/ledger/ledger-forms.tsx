"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui";
import {
  SLIP_CATEGORIES,
  PAYMENT_METHODS,
  type SlipCategory,
  type PaymentMethod,
} from "@/domain/ledger/ledger-service";
import { buildGibierCatalog } from "@/domain/billing/gibier-catalog";
import { createSalesSlipAction, voidSalesSlipAction } from "./actions";

const inputClass = "w-full rounded-lg border border-stone-300 px-3 py-3 text-base";

/**
 * 売上伝票のクイック入力。現場スタッフがスマホ片手で使う前提:
 * 大きなタップ対象・種別と支払はボタン選択・最少入力（種別/品目/金額）。
 */
export function NewSalesSlipForm({
  staffNames,
  products,
  priceMaster,
}: {
  staffNames: string[];
  products: Record<string, unknown>[];
  priceMaster: Record<string, unknown>[];
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [category, setCategory] = useState<SlipCategory>("retail");
  const [payment, setPayment] = useState<PaymentMethod>("cash");
  const [item, setItem] = useState("");
  const [amount, setAmount] = useState("");
  const [productId, setProductId] = useState("");
  const today = new Date().toLocaleDateString("sv-SE");

  // ジビエ在庫管理システムの品目カタログ（店頭手売りは標準価格）
  const catalog = buildGibierCatalog(products, priceMaster, "standard");
  const pickCatalogItem = (key: string) => {
    const entry = catalog.find((c) => c.key === key);
    if (!entry) return;
    setItem(entry.kind === "part" ? `${entry.name}（kg数を数量に）` : entry.name);
    setAmount(entry.kind === "product" && entry.price ? String(entry.price) : "");
    setProductId(entry.productId ?? "");
  };

  const chip = (active: boolean) =>
    `min-h-12 rounded-xl border px-3 py-2 text-sm font-semibold ${
      active ? "border-green-700 bg-green-700 text-white" : "border-stone-300 bg-white text-stone-600"
    }`;

  return (
    <Card>
      <form
        action={(formData) => {
          setError(null);
          setSaved(null);
          startTransition(async () => {
            const result = await createSalesSlipAction(formData);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setSaved("登録しました");
          });
        }}
        className="space-y-3"
      >
        <input type="hidden" name="category" value={category} />
        <input type="hidden" name="payment_method" value={payment} />

        <div>
          <p className="mb-1 text-xs font-semibold text-stone-500">なにの売上？</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {(Object.entries(SLIP_CATEGORIES) as [SlipCategory, string][]).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setCategory(key)}
                className={chip(category === key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <input type="hidden" name="product_id" value={productId} />
        {catalog.length ? (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) pickCatalogItem(e.target.value);
            }}
            className={inputClass}
          >
            <option value="">🐗 在庫から品目を選ぶ（任意・価格自動入力）</option>
            <optgroup label="完成品（在庫あり）">
              {catalog
                .filter((c) => c.kind === "product" && (c.stockQty ?? 0) > 0)
                .map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name} ｜ 在庫{c.stockQty}
                    {c.unit} ｜ ¥{c.price.toLocaleString()}
                  </option>
                ))}
            </optgroup>
            <optgroup label="部位単価（kg）">
              {catalog
                .filter((c) => c.kind === "part")
                .map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name} ｜ ¥{c.price.toLocaleString()}/kg
                  </option>
                ))}
            </optgroup>
          </select>
        ) : null}
        <input
          name="item"
          required
          value={item}
          onChange={(e) => {
            setItem(e.target.value);
            setProductId(""); // 手入力に変えたら在庫との紐づけは外す
          }}
          placeholder="品目・内容（例: イノシシロース 300g / 体験2名）"
          className={inputClass}
        />
        <div className="flex gap-2">
          <input
            name="amount"
            type="number"
            inputMode="numeric"
            min="1"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="金額（税込・円）"
            className={inputClass + " text-lg font-bold"}
          />
          <input
            name="quantity"
            type="number"
            inputMode="decimal"
            step="any"
            placeholder="数量"
            className={inputClass + " max-w-24"}
          />
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold text-stone-500">支払い</p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {(Object.entries(PAYMENT_METHODS) as [PaymentMethod, string][]).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setPayment(key)}
                className={chip(payment === key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <input name="sale_date" type="date" defaultValue={today} required className={inputClass + " max-w-40"} />
          <select name="staff_name" className={inputClass}>
            <option value="">対応スタッフ（任意）</option>
            {staffNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <input name="note" placeholder="メモ（任意）" className={inputClass} />

        <button
          type="submit"
          disabled={isPending}
          className="min-h-12 w-full rounded-xl bg-green-700 px-4 py-3 text-base font-bold text-white disabled:opacity-50"
        >
          {isPending ? "登録中…" : "伝票を登録"}
        </button>
        {saved ? <p className="text-sm font-semibold text-green-700">✓ {saved}</p> : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </form>
    </Card>
  );
}

export function VoidSlipButton({ slipId }: { slipId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <button
        onClick={() => {
          if (!confirm("この伝票を取消にしますか？（番号は欠番として残ります）")) return;
          startTransition(async () => {
            const result = await voidSalesSlipAction(slipId);
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
