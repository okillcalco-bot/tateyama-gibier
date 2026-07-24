"use client";

import { useState, useTransition, useEffect } from "react";
import { Card } from "@/components/ui";
import type { ActionResult } from "@/lib/action-result";
import { SENSITIVITY } from "@/domain/satoyama/geo-masking";
import {
  quickObservationAction,
  parseFieldNoteAction,
  reviewObservationAction,
  createTaxonAction,
} from "./actions";

const inputClass = "w-full rounded-lg border border-stone-300 px-3 py-3 text-base";
const bigButton =
  "min-h-12 w-full rounded-xl bg-green-700 px-4 py-3 text-base font-bold text-white disabled:opacity-50";

function useAction() {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult>, onDone?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone?.();
    });
  };
  return { isPending, error, run };
}

export interface SiteOption {
  id: string;
  name: string;
}
export interface TaxonOption {
  id: string;
  name: string;
  group: string;
  sensitivity: string;
}

const EVIDENCE_TYPES: [string, string][] = [
  ["sighting", "目視"],
  ["photo", "写真"],
  ["audio", "鳴き声"],
  ["track", "痕跡（足跡・食痕・糞）"],
  ["stomach", "胃内容物"],
  ["specimen", "標本"],
  ["hearsay", "聞き取り"],
];

/**
 * かんたん投稿（設計書 S02）。
 * 写真・GPS・種名だけで3タップ以内に登録できることを最優先にする。
 */
export function QuickObservationForm({
  sites,
  taxa,
}: {
  sites: SiteOption[];
  taxa: TaxonOption[];
}) {
  const { isPending, error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [taxonId, setTaxonId] = useState("");
  const [evidence, setEvidence] = useState("sighting");

  // 位置情報は開いた時点で取得しておく（現場で待たされないように）
  useEffect(() => {
    if (!navigator.geolocation) {
      setGeoError("この端末では位置情報を取得できません");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setGeoError("位置情報が取得できませんでした（設定で許可してください）"),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, []);

  const selected = taxa.find((t) => t.id === taxonId);
  const sensitivity = (selected?.sensitivity ?? "normal") as keyof typeof SENSITIVITY;

  return (
    <Card>
      <form
        action={(formData) =>
          run(() => quickObservationAction(formData), () => {
            setSaved(true);
            setTaxonId("");
          })
        }
        className="space-y-3"
      >
        <input type="hidden" name="lat" value={coords?.lat ?? ""} />
        <input type="hidden" name="lng" value={coords?.lng ?? ""} />
        <input type="hidden" name="observed_at" value={new Date().toISOString()} />
        <input type="hidden" name="evidence_type" value={evidence} />

        <select name="site_id" required className={inputClass}>
          <option value="">対象地を選ぶ</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <div>
          <select
            name="taxon_id"
            value={taxonId}
            onChange={(e) => setTaxonId(e.target.value)}
            className={inputClass}
          >
            <option value="">種を選ぶ（一覧にない・不明なら下に入力）</option>
            {taxa.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.group ? `（${t.group}）` : ""}
                {t.sensitivity === "sensitive" ? " ⚠️希少" : ""}
              </option>
            ))}
          </select>
          {sensitivity === "sensitive" ? (
            <p className="mt-1 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
              ⚠️ 希少種のため、この記録は自動的に「認定者のみ」に制限され、
              一般公開では座標を表示しません。
            </p>
          ) : null}
        </div>

        <input
          name="species_name"
          placeholder="種名（わからなければ「不明」でOK）"
          className={inputClass}
        />

        <div>
          <p className="mb-1 text-xs font-semibold text-stone-500">証拠の種類</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {EVIDENCE_TYPES.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setEvidence(key)}
                className={`min-h-11 rounded-xl border px-2 text-sm font-semibold ${
                  evidence === key
                    ? "border-green-700 bg-green-700 text-white"
                    : "border-stone-300 bg-white text-stone-600"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <input name="count" type="number" inputMode="numeric" placeholder="個体数" className={inputClass + " max-w-28"} />
          <input name="observer" placeholder="観察者（任意）" className={inputClass} />
        </div>

        <div>
          <p className="mb-1 text-xs text-stone-500">写真（証跡・任意）</p>
          <input name="photo" type="file" accept="image/*" capture="environment" className="text-sm" />
        </div>

        <textarea name="note" rows={2} placeholder="メモ（環境・行動・気づいたこと）" className={inputClass} />

        <p className="text-xs text-stone-500">
          {coords
            ? `📍 位置取得済み（${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}）`
            : geoError
              ? `📍 ${geoError}`
              : "📍 位置情報を取得中…"}
        </p>

        <button type="submit" disabled={isPending} className={bigButton}>
          {isPending ? "記録中…" : "この内容で記録する"}
        </button>
        {saved ? (
          <p className="text-sm font-semibold text-green-700">
            ✓ 記録しました（レビュー待ち）。続けて次の記録ができます。
          </p>
        ) : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </form>
    </Card>
  );
}

/** 現場メモのAI整理（音声の文字起こしを貼る / 走り書き） */
export function FieldNoteForm({ sites }: { sites: SiteOption[] }) {
  const { isPending, error, run } = useAction();
  const [done, setDone] = useState(false);
  return (
    <Card>
      <form
        action={(formData) => run(() => parseFieldNoteAction(formData), () => setDone(true))}
        className="space-y-2"
      >
        <select name="site_id" className={inputClass}>
          <option value="">対象地（任意）</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <textarea
          name="raw_text"
          rows={4}
          required
          placeholder="現場のメモをそのまま。例: 地点A、モウソウチク、枯死7割、タケノコ3本、食痕あり、湿地の北側でアカガエルの卵塊3つ"
          className={inputClass}
        />
        <input type="hidden" name="observed_at" value={new Date().toISOString()} />
        <button type="submit" disabled={isPending} className={bigButton}>
          {isPending ? "AIが整理中…" : "AIに整理してもらう（候補を作る）"}
        </button>
        {done ? (
          <p className="text-sm text-green-700">
            候補を作りました。承認センターで確認・修正して確定してください。
          </p>
        ) : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <p className="text-xs text-stone-400">
          AIは種を確定しません。候補として複数を提示し、人が選んで確定します。
          希少種・営巣地・罠の位置が含まれる場合は自動で「要確認」になります。
        </p>
      </form>
    </Card>
  );
}

export function ReviewButtons({ observationId }: { observationId: string }) {
  const { isPending, error, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={() => run(() => reviewObservationAction(observationId, "approved"))}
        disabled={isPending}
        className="rounded-lg bg-green-700 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
      >
        承認
      </button>
      <button
        onClick={() => {
          const note = prompt("差し戻しの理由（任意）") ?? undefined;
          run(() => reviewObservationAction(observationId, "rejected", note));
        }}
        disabled={isPending}
        className="rounded-lg border border-stone-300 px-3 py-1 text-xs text-stone-600 disabled:opacity-50"
      >
        差し戻し
      </button>
      <button
        onClick={() => {
          const note = prompt("異議の内容（任意）") ?? undefined;
          run(() => reviewObservationAction(observationId, "disputed", note));
        }}
        disabled={isPending}
        className="text-xs text-amber-700 underline disabled:opacity-50"
      >
        異議
      </button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </span>
  );
}

/** 種マスタ登録（希少度の設定がセキュリティに直結する） */
export function NewTaxonForm() {
  const { isPending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm text-green-700 underline">
        ＋ 種マスタに追加
      </button>
    );
  }
  return (
    <Card>
      <form
        action={(formData) => run(() => createTaxonAction(formData), () => setOpen(false))}
        className="space-y-2"
      >
        <div className="flex gap-2">
          <input name="common_name" required placeholder="和名" className={inputClass} />
          <input name="taxon_group" placeholder="分類群（鳥類等）" className={inputClass} />
        </div>
        <div className="flex gap-2">
          <input name="scientific_name" placeholder="学名（任意）" className={inputClass} />
          <input name="red_list_status" placeholder="RLカテゴリ（任意）" className={inputClass + " max-w-40"} />
        </div>
        <select name="sensitivity" defaultValue="normal" className={inputClass}>
          {Object.entries(SENSITIVITY).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <p className="text-xs text-amber-700">
          希少種を選ぶと、その種の記録は自動で非公開・座標非表示になります。
        </p>
        <div className="flex gap-2">
          <button type="submit" disabled={isPending} className={bigButton + " flex-1"}>
            {isPending ? "登録中…" : "登録"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg border border-stone-300 px-4 text-sm text-stone-600"
          >
            閉じる
          </button>
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </form>
    </Card>
  );
}
