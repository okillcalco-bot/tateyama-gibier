"use client";

import { useTransition, useState } from "react";
import {
  createSite,
  addObservation,
  addManagementAction,
  generateNatureReportAction,
} from "./actions";
import { Card } from "@/components/ui";

function useAction() {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<void>, onDone?: () => void) => {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        onDone?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : "エラーが発生しました");
      }
    });
  };
  return { isPending, error, run };
}

const inputClass = "w-full rounded-lg border border-stone-300 px-3 py-2 text-sm";
const buttonClass =
  "rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";

/** 対象地の新規登録フォーム */
export function NewSiteForm() {
  const { isPending, error, run } = useAction();
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={buttonClass + " w-full"}>
        ＋ 対象地を登録
      </button>
    );
  }
  return (
    <Card>
      <form
        action={(formData) =>
          run(
            () => createSite(formData),
            () => setOpen(false),
          )
        }
        className="space-y-3"
      >
        <input name="name" required placeholder="対象地名" className={inputClass} />
        <div className="flex gap-2">
          <select name="site_type" className={inputClass} defaultValue="own_field">
            <option value="own_field">自社フィールド</option>
            <option value="client_site">支援先サイト</option>
            <option value="candidate">候補地</option>
          </select>
          <select name="oecm_status" className={inputClass} defaultValue="none">
            <option value="none">認証対象外</option>
            <option value="preparing">認証準備中</option>
            <option value="applied">申請中</option>
            <option value="certified">認証済</option>
          </select>
        </div>
        <div className="flex gap-2">
          <input name="address" placeholder="所在地" className={inputClass} />
          <input name="area_ha" type="number" step="0.1" placeholder="面積(ha)" className={inputClass} />
        </div>
        <textarea name="description" rows={2} placeholder="概要（環境・特徴）" className={inputClass} />
        <div className="flex gap-2">
          <button type="submit" disabled={isPending} className={buttonClass + " flex-1"}>
            {isPending ? "登録中…" : "登録"}
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

/** 観察記録フォーム（モバイル現場入力: 写真 + GPS） */
export function ObservationForm({ siteId }: { siteId: string }) {
  const { isPending, error, run } = useAction();
  const [gps, setGps] = useState<{ lat: number; lng: number } | null>(null);
  const [gpsStatus, setGpsStatus] = useState<string>("");

  const captureGps = () => {
    if (!navigator.geolocation) {
      setGpsStatus("この端末では位置情報を取得できません");
      return;
    }
    setGpsStatus("取得中…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGps({ lat: position.coords.latitude, lng: position.coords.longitude });
        setGpsStatus(
          `📍 ${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(5)}`,
        );
      },
      () => setGpsStatus("位置情報の取得に失敗しました"),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  return (
    <form
      id="observation-form"
      action={(formData) =>
        run(async () => {
          await addObservation(siteId, formData);
          (document.getElementById("observation-form") as HTMLFormElement | null)?.reset();
          setGps(null);
          setGpsStatus("");
        })
      }
      className="space-y-2"
    >
      <div className="flex gap-2">
        <input name="species_name" required placeholder="種名（例: ニホンアカガエル）" className={inputClass} />
        <select name="taxon_group" className={inputClass + " max-w-28"} defaultValue="">
          <option value="">分類</option>
          <option>哺乳類</option>
          <option>鳥類</option>
          <option>両生類</option>
          <option>爬虫類</option>
          <option>昆虫</option>
          <option>魚類</option>
          <option>植物</option>
          <option>その他</option>
        </select>
      </div>
      <div className="flex gap-2">
        <input name="count" type="number" min="1" placeholder="個体数" className={inputClass + " max-w-24"} />
        <input name="observed_at" type="datetime-local" className={inputClass} />
      </div>
      <input name="note" placeholder="状況メモ（例: 卵塊を確認）" className={inputClass} />
      <div className="flex items-center gap-2">
        <input
          name="photo"
          type="file"
          accept="image/*"
          capture="environment"
          className="flex-1 text-sm"
        />
        <button
          type="button"
          onClick={captureGps}
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm text-stone-600"
        >
          📍 現在地
        </button>
      </div>
      {gpsStatus ? <p className="text-xs text-stone-500">{gpsStatus}</p> : null}
      <input type="hidden" name="lat" value={gps?.lat ?? ""} />
      <input type="hidden" name="lng" value={gps?.lng ?? ""} />
      <button type="submit" disabled={isPending} className={buttonClass + " w-full"}>
        {isPending ? "保存中…" : "観察を記録"}
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </form>
  );
}

/** 管理作業フォーム */
export function ManagementActionForm({ siteId }: { siteId: string }) {
  const { isPending, error, run } = useAction();
  return (
    <form
      id="action-form"
      action={(formData) =>
        run(async () => {
          await addManagementAction(siteId, formData);
          (document.getElementById("action-form") as HTMLFormElement | null)?.reset();
        })
      }
      className="space-y-2"
    >
      <div className="flex gap-2">
        <select name="action_type" required className={inputClass} defaultValue="">
          <option value="" disabled>
            作業種別
          </option>
          <option>草刈り</option>
          <option>間伐</option>
          <option>竹林整備</option>
          <option>水辺整備</option>
          <option>外来種駆除</option>
          <option>歩道整備</option>
          <option>その他</option>
        </select>
        <input name="action_date" type="date" className={inputClass} />
        <input name="hours" type="number" step="0.5" placeholder="時間" className={inputClass + " max-w-20"} />
      </div>
      <input name="description" placeholder="作業内容メモ" className={inputClass} />
      <button type="submit" disabled={isPending} className={buttonClass + " w-full"}>
        {isPending ? "保存中…" : "作業を記録"}
      </button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </form>
  );
}

/** レポートドラフト生成 */
export function GenerateReportButton({ siteId }: { siteId: string }) {
  const { isPending, error, run } = useAction();
  const [purpose, setPurpose] = useState("自然共生サイト認証申請");
  const [done, setDone] = useState(false);

  return (
    <div className="space-y-2">
      <select value={purpose} onChange={(e) => setPurpose(e.target.value)} className={inputClass}>
        <option>自然共生サイト認証申請</option>
        <option>企業向け提案書</option>
        <option>行政向け報告</option>
        <option>TNFD関連資料</option>
      </select>
      <button
        onClick={() =>
          run(
            () => generateNatureReportAction(siteId, purpose),
            () => setDone(true),
          )
        }
        disabled={isPending}
        className={buttonClass + " w-full"}
      >
        {isPending ? "AIがレポート生成中…" : "レポートドラフトをAI生成"}
      </button>
      {done ? (
        <p className="text-sm text-green-700">
          ドラフトを生成しました。承認センター（承認タブ）でレビューしてください。
        </p>
      ) : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <p className="text-xs text-stone-400">
        登録済みの観察記録・管理作業のみを根拠に生成します。実在しない証跡IDを
        引用した出力は保存自体が拒否されます。証跡不足はレポートに明示されます。
      </p>
    </div>
  );
}
