"use client";

import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";
import {
  approveCaptureReportAction,
  rejectCaptureReportAction,
  saveAcceptanceStatusAction,
  setPhotoKindAction,
} from "./actions";

/**
 * 捕獲報告の確認フォーム。
 * 高齢者UI原則: ボタンは高さ56px以上、ラベルは何が起きるかを書く、
 * 状態は色だけで示さない、390px幅で横スクロールしない。
 */

const BUTTON_BASE =
  "w-full min-h-[56px] rounded-xl px-4 text-base font-bold disabled:opacity-50";
const FIELD =
  "mt-1 w-full min-h-[56px] rounded-xl border-2 border-stone-300 bg-white px-3 text-base";

const SPECIES_OPTIONS = ["イノシシ", "シカ", "キョン", "その他"];
const METHOD_OPTIONS = ["くくり罠", "箱罠", "銃猟", "その他"];

function useAction() {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: (formData: FormData) => Promise<ActionResult>, formData: FormData) => {
    setError(null);
    startTransition(async () => {
      const result = await fn(formData);
      if (!result.ok) setError(result.error);
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

/** 本日の受入可否（捕獲者の「受入状況」への回答になる） */
export function AcceptanceStatusForm({
  accepting,
  note,
}: {
  accepting: boolean | null;
  note: string;
}) {
  const { isPending, error, run } = useAction();
  const [noteText, setNoteText] = useState(note);

  const submit = (value: "受入可" | "受入停止") => {
    const formData = new FormData();
    formData.set("accepting", value);
    formData.set("note", noteText);
    run(saveAcceptanceStatusAction, formData);
  };

  return (
    <div className="space-y-3">
      <p className="text-base font-bold text-stone-700">
        <span aria-hidden="true">{accepting === true ? "●" : accepting === false ? "×" : "－"}</span>{" "}
        いまの設定：
        {accepting === true
          ? "受け入れできます"
          : accepting === false
            ? "受け入れを止めています"
            : "まだ設定されていません"}
      </p>
      <label className="block">
        <span className="text-base font-bold text-stone-700">捕獲者へ伝える一言（任意）</span>
        <input
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="例）本日は16時までにお願いします"
          className={FIELD}
        />
      </label>
      <button
        type="button"
        disabled={isPending}
        onClick={() => submit("受入可")}
        className={`${BUTTON_BASE} bg-green-700 text-white`}
      >
        ○ 今日は受け入れできる
      </button>
      <button
        type="button"
        disabled={isPending}
        onClick={() => submit("受入停止")}
        className={`${BUTTON_BASE} border-2 border-stone-400 bg-white text-stone-700`}
      >
        × 今日は受け入れを止める
      </button>
      <ErrorText error={error} />
    </div>
  );
}

/** 捕獲報告を個体（仮登録）にする */
export function ApproveReportForm({
  reportId,
  hunterName,
  defaultSpecies,
  defaultMethod,
  defaultDate,
  defaultWeightKg = "",
  defaultWeightMeasure = "",
}: {
  reportId: string;
  hunterName: string;
  defaultSpecies: string;
  defaultMethod: string;
  defaultDate: string;
  defaultWeightKg?: string;
  defaultWeightMeasure?: string;
}) {
  const { isPending, error, run } = useAction();
  const [species, setSpecies] = useState(defaultSpecies);
  const [method, setMethod] = useState(defaultMethod);
  const [date, setDate] = useState(defaultDate);
  const [reason, setReason] = useState("");

  return (
    <form
      action={(formData) => {
        formData.set("report_id", reportId);
        formData.set("species", species);
        formData.set("capture_method", method);
        formData.set("capture_date", date);
        formData.set("hunter_name", hunterName);
        run(approveCaptureReportAction, formData);
      }}
      className="mt-3 space-y-3"
    >
      <p className="text-base text-stone-700">
        AIの読み取りは<strong>下書き</strong>です。正しいか確かめてから登録してください。
      </p>

      <label className="block">
        <span className="text-base font-bold text-stone-700">獣種（必須）</span>
        <select value={species} onChange={(e) => setSpecies(e.target.value)} className={FIELD}>
          <option value="">えらんでください</option>
          {SPECIES_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-base font-bold text-stone-700">捕獲方法</span>
        <select value={method} onChange={(e) => setMethod(e.target.value)} className={FIELD}>
          <option value="">えらんでください</option>
          {METHOD_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-base font-bold text-stone-700">捕獲日</span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className={FIELD}
        />
      </label>

      <div className="rounded-xl bg-stone-50 p-3">
        <p className="text-base font-bold text-stone-700">体重</p>
        <label className="mt-2 block">
          <span className="text-base text-stone-700">どこで測りましたか</span>
          <select name="weight_measure" defaultValue={defaultWeightMeasure} className={FIELD}>
            <option value="">えらんでください</option>
            <option value="center">ジビエセンターで計量</option>
            <option value="facility">処理施設で計量</option>
            <option value="estimated">推定（計量していない）</option>
          </select>
        </label>
        <label className="mt-2 block">
          <span className="text-base text-stone-700">体重（kg）</span>
          <input
            name="weight_kg"
            inputMode="decimal"
            defaultValue={defaultWeightKg}
            className={FIELD}
          />
        </label>
        <p className="mt-1 text-sm text-stone-600">
          推定を選ぶと、市役所に出す書類に「推定値」と印字されます。
        </p>
      </div>

      <details className="rounded-xl bg-stone-50 p-3">
        <summary className="text-base font-bold text-stone-700">
          捕獲票に必要なその他の項目（わかる分だけ）
        </summary>
        <div className="mt-2 space-y-2">
          <label className="block">
            <span className="text-base text-stone-700">性別</span>
            <select name="sex" className={FIELD}>
              <option value="">えらんでください</option>
              <option value="オス">オス</option>
              <option value="メス">メス</option>
            </select>
          </label>
          <label className="block">
            <span className="text-base text-stone-700">成獣か幼獣か</span>
            <select name="is_juvenile" className={FIELD}>
              <option value="成獣">成獣</option>
              <option value="幼獣">幼獣</option>
            </select>
          </label>
          <label className="block">
            <span className="text-base text-stone-700">体長（cm）</span>
            <input name="body_length_cm" inputMode="decimal" className={FIELD} />
          </label>
          <label className="block">
            <span className="text-base text-stone-700">箱わな番号</span>
            <input name="trap_number" className={FIELD} />
          </label>
          <label className="block">
            <span className="text-base text-stone-700">餌の種類（箱わなのみ）</span>
            <input name="bait_type" className={FIELD} />
          </label>
          <label className="block">
            <span className="text-base text-stone-700">わな設置日</span>
            <input type="date" name="trap_set_date" className={FIELD} />
          </label>
          <label className="block">
            <span className="text-base text-stone-700">止め刺し方法</span>
            <select name="finishing_method" className={FIELD}>
              <option value="">えらんでください</option>
              <option value="銃">射殺（銃）</option>
              <option value="刺殺">刺殺（竹槍・ナイフなど）</option>
              <option value="既に死亡">既に死亡</option>
            </select>
          </label>
          <label className="block">
            <span className="text-base text-stone-700">処理方法</span>
            <input
              name="disposal_method"
              defaultValue="販売（館山ジビエセンター）"
              className={FIELD}
            />
          </label>
        </div>
      </details>

      <button
        type="submit"
        disabled={isPending || !species || !hunterName}
        className={`${BUTTON_BASE} bg-green-700 text-white`}
      >
        ✓ 個体として登録する（搬入待ち）
      </button>
      {!hunterName ? (
        <p className="rounded-lg bg-amber-50 p-2 text-base font-bold text-amber-900">
          ⚠ 捕獲者が確定していません。先に「捕獲者LINE」でお名前を紐付けてください。
        </p>
      ) : null}

      <label className="block">
        <span className="text-base font-bold text-stone-700">取り消す理由（任意）</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="例）同じ内容が2回届いた"
          className={FIELD}
        />
      </label>
      <button
        type="button"
        disabled={isPending}
        onClick={() => {
          const formData = new FormData();
          formData.set("report_id", reportId);
          formData.set("reason", reason);
          run(rejectCaptureReportAction, formData);
        }}
        className={`${BUTTON_BASE} border-2 border-stone-400 bg-white text-stone-700`}
      >
        ✕ この報告を取り消す（個体は作りません）
      </button>

      <ErrorText error={error} />
    </form>
  );
}

/** 写真の種別を職員が決める（市役所提出の台紙に並べるため） */
export function PhotoKindForm({
  photoId,
  photoKind,
}: {
  photoId: string;
  photoKind: string;
}) {
  const { isPending, error, run } = useAction();
  const [kind, setKind] = useState(photoKind);

  const options: { value: string; label: string }[] = [
    { value: "unsorted", label: "未仕分け" },
    { value: "whole", label: "全体" },
    { value: "tail_before", label: "尻尾を切る前" },
    { value: "tail_after", label: "尻尾を切った後" },
    { value: "other", label: "その他" },
  ];

  return (
    <div className="mt-2">
      <label className="block">
        <span className="text-base font-bold text-stone-700">この写真は何ですか</span>
        <select
          value={kind}
          disabled={isPending}
          onChange={(e) => {
            const next = e.target.value;
            setKind(next);
            const formData = new FormData();
            formData.set("photo_id", photoId);
            formData.set("photo_kind", next);
            run(setPhotoKindAction, formData);
          }}
          className={FIELD}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <ErrorText error={error} />
    </div>
  );
}
