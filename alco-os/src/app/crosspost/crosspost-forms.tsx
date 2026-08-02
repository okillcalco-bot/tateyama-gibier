"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult, ActionResultWith } from "@/lib/action-result";
import {
  approveDraftAction,
  createSourceAction,
  editDraftAction,
  generateDraftsAction,
  recordPublishedAction,
  rejectDraftAction,
  reopenDraftAction,
  saveStyleAction,
  setAssetFlagsAction,
  toggleChannelAction,
} from "./actions";

/**
 * FB横展開システムの操作フォーム。
 *
 * スマホ優先（375px幅で横スクロールなし）:
 * - ボタンは高さ56px以上・1行1ボタン
 * - 状態は色だけでなく記号と文字でも示す
 * - 長い本文は break-words で折り返す
 */

const BUTTON = "w-full min-h-[56px] rounded-xl px-4 text-base font-bold disabled:opacity-50";
const FIELD =
  "mt-1 w-full min-h-[56px] rounded-xl border-2 border-stone-300 bg-white px-3 text-base";
const AREA = "mt-1 w-full rounded-xl border-2 border-stone-300 p-3 text-base";

function useAction() {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = (fn: (fd: FormData) => Promise<ActionResult>, fd: FormData, message?: string) => {
    setError(null);
    setDone(null);
    startTransition(async () => {
      const result = await fn(fd);
      if (result.ok) setDone(message ?? "保存しました");
      else setError(result.error);
    });
  };
  return { isPending, error, done, run, setError, setDone, startTransition };
}

function Notice({ error, done }: { error: string | null; done: string | null }) {
  if (error) {
    return (
      <p className="mt-2 rounded-lg bg-red-50 p-2 text-base font-bold text-red-700">⚠ {error}</p>
    );
  }
  if (done) {
    return (
      <p className="mt-2 rounded-lg bg-green-50 p-2 text-base font-bold text-green-800">
        ✓ {done}
      </p>
    );
  }
  return null;
}

export const SOURCE_CATEGORIES = [
  "現場記録",
  "ジビエ",
  "研究データ",
  "自然資本",
  "里山",
  "経営",
  "地域活動",
  "イベント告知",
  "商品営業",
  "個人的な気づき",
  "その他",
];

/** ② 新規登録 */
export function NewSourceForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  return (
    <form
      action={(formData) => {
        setError(null);
        setWarnings([]);
        startTransition(async () => {
          const result: ActionResultWith<{ sourceId: string; warnings: string[] }> =
            await createSourceAction(formData);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setWarnings(result.data.warnings);
          router.push(`/crosspost/${result.data.sourceId}`);
        });
      }}
      className="space-y-4"
    >
      <label className="block">
        <span className="text-base font-bold text-stone-700">原文（必須）</span>
        <textarea name="body" rows={10} required className={AREA} placeholder="Facebookの投稿本文をそのまま貼り付けてください" />
      </label>

      <label className="block">
        <span className="text-base font-bold text-stone-700">投稿URL</span>
        <input name="source_url" inputMode="url" className={FIELD} placeholder="https://www.facebook.com/..." />
        <span className="mt-1 block text-sm text-stone-500">
          同じURLは二重登録できません（登録済みかの判定に使います）
        </span>
      </label>

      <div className="grid grid-cols-1 gap-3">
        <label className="block">
          <span className="text-base font-bold text-stone-700">タイトル</span>
          <input name="title" className={FIELD} />
        </label>
        <label className="block">
          <span className="text-base font-bold text-stone-700">投稿番号（#連番）</span>
          <input name="source_no" inputMode="numeric" className={FIELD} placeholder="空欄なら原文から自動で読み取ります" />
        </label>
        <label className="block">
          <span className="text-base font-bold text-stone-700">投稿日</span>
          <input type="date" name="posted_on" className={FIELD} />
        </label>
        <label className="block">
          <span className="text-base font-bold text-stone-700">カテゴリ</span>
          <select name="category" className={FIELD}>
            <option value="">えらんでください</option>
            {SOURCE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-base font-bold text-stone-700">公開範囲</span>
          <input name="visibility" className={FIELD} placeholder="全体公開 / 友だちのみ など" />
        </label>
      </div>

      <label className="block">
        <span className="text-base font-bold text-stone-700">写真・動画</span>
        <input type="file" name="photos" multiple accept="image/*,video/*" className={FIELD} />
      </label>
      <label className="flex min-h-[56px] items-center gap-3 rounded-xl bg-amber-50 px-3">
        <input type="checkbox" name="has_person" className="h-6 w-6" />
        <span className="text-base font-bold text-amber-900">
          いずれかの写真に人物が写っている
        </span>
      </label>
      <label className="flex min-h-[56px] items-center gap-3 rounded-xl bg-amber-50 px-3">
        <input type="checkbox" name="needs_public_check" className="h-6 w-6" />
        <span className="text-base font-bold text-amber-900">
          いずれかの写真に公開の確認が必要
        </span>
      </label>
      <p className="text-sm text-stone-500">
        ここでの指定はすべての写真に付きます。登録後、詳細画面で写真ごとに直せます。
      </p>

      <label className="block">
        <span className="text-base font-bold text-stone-700">補足メモ</span>
        <textarea name="note" rows={3} className={AREA} />
      </label>

      <button type="submit" disabled={isPending} className={`${BUTTON} bg-green-700 text-white`}>
        ＋ 登録する
      </button>
      {warnings.map((w) => (
        <p key={w} className="rounded-lg bg-amber-50 p-2 text-base font-bold text-amber-900">
          ！ {w}
        </p>
      ))}
      <Notice error={error} done={null} />
    </form>
  );
}

/** 下書きを作る／作り直す */
export function GenerateButton({
  sourceId,
  channelKey,
  label,
}: {
  sourceId: string;
  channelKey?: string;
  label: string;
}) {
  const { isPending, error, done, run } = useAction();
  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={isPending}
        onClick={() => {
          const fd = new FormData();
          fd.set("source_id", sourceId);
          if (channelKey) fd.set("channel_key", channelKey);
          run(
            (f) => generateDraftsAction(f).then((r) => (r.ok ? { ok: true } : r)),
            fd,
            "下書きを作りました",
          );
        }}
        className={`${BUTTON} bg-green-700 text-white`}
      >
        {isPending ? "作成中…（少し時間がかかります）" : label}
      </button>
      <Notice error={error} done={done} />
    </div>
  );
}

/** ⑤⑥ 媒体ごとの編集・承認・却下 */
export function ChannelDraftForm({
  sourceId,
  draftId,
  body,
  reviewReasons,
  status,
  canApprove,
}: {
  sourceId: string;
  draftId: string;
  body: string;
  reviewReasons: string[];
  status: string;
  canApprove: boolean;
}) {
  const { isPending, error, done, run } = useAction();
  const [text, setText] = useState(body);
  const [reason, setReason] = useState("");
  const [url, setUrl] = useState("");

  const base = (extra?: Record<string, string>) => {
    const fd = new FormData();
    fd.set("source_id", sourceId);
    fd.set("draft_id", draftId);
    for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
    return fd;
  };

  const editable = status !== "approved" && status !== "published";

  return (
    <div className="mt-3 space-y-3">
      {reviewReasons.length > 0 ? (
        <div className="rounded-xl bg-amber-50 p-3">
          <p className="text-base font-bold text-amber-900">！ 確認が必要な理由</p>
          <ul className="mt-1 space-y-1 text-base text-amber-900">
            {reviewReasons.map((r) => (
              <li key={r}>・{r}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {editable ? (
        <>
          <label className="block">
            <span className="text-base font-bold text-stone-700">本文（編集できます）</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              className={AREA}
            />
            <span className="mt-1 block text-sm text-stone-500">{text.length}字</span>
          </label>
          <button
            type="button"
            disabled={isPending}
            onClick={() => run(editDraftAction, base({ body: text }), "本文を保存しました")}
            className={`${BUTTON} border-2 border-stone-400 bg-white text-stone-700`}
          >
            ✎ 本文を保存する
          </button>
        </>
      ) : (
        <p className="whitespace-pre-wrap break-words rounded-xl bg-stone-50 p-3 text-base text-stone-800">
          {body}
        </p>
      )}

      {canApprove ? (
        <>
          {editable ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() =>
                run(
                  approveDraftAction,
                  base(reviewReasons.length > 0 ? { acknowledge: "on" } : {}),
                  "承認しました",
                )
              }
              className={`${BUTTON} bg-green-700 text-white`}
            >
              {reviewReasons.length > 0 ? "✓ 理由を確認して承認する" : "✓ この媒体を承認する"}
            </button>
          ) : null}

          {status === "approved" ? (
            <>
              <label className="block">
                <span className="text-base font-bold text-stone-700">投稿したURL</span>
                <input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  inputMode="url"
                  className={FIELD}
                  placeholder="https://..."
                />
              </label>
              <button
                type="button"
                disabled={isPending}
                onClick={() =>
                  run(recordPublishedAction, base({ posted_url: url }), "投稿済みにしました")
                }
                className={`${BUTTON} bg-green-700 text-white`}
              >
                ✔ 投稿済みにする
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => run(reopenDraftAction, base(), "差し戻しました")}
                className={`${BUTTON} border-2 border-stone-400 bg-white text-stone-700`}
              >
                ↩ 承認を取り消して直す
              </button>
            </>
          ) : null}

          {editable ? (
            <>
              <label className="block">
                <span className="text-base font-bold text-stone-700">却下する理由</span>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className={FIELD}
                  placeholder="例）この媒体には向かない内容"
                />
              </label>
              <button
                type="button"
                disabled={isPending || !reason.trim()}
                onClick={() => run(rejectDraftAction, base({ reason }), "却下しました")}
                className={`${BUTTON} border-2 border-stone-400 bg-white text-stone-700`}
              >
                ✕ この媒体は使わない（却下）
              </button>
            </>
          ) : null}
        </>
      ) : (
        <p className="text-base text-stone-600">
          承認・却下・投稿済み登録は、承認権限のある人だけができます。
        </p>
      )}

      <Notice error={error} done={done} />
    </div>
  );
}

/** ⑨ 沖浩志スタイル設定 */
export function StyleForm({
  structureNotes,
  keepRules,
  avoidRules,
  hardRules,
  version,
}: {
  structureNotes: string;
  keepRules: string;
  avoidRules: string;
  hardRules: string;
  version: number;
}) {
  const { isPending, error, done, run } = useAction();
  return (
    <form
      action={(fd) => run(saveStyleAction, fd, "新しい版として保存しました")}
      className="space-y-3"
    >
      <p className="text-base text-stone-700">
        いまの版：version {version}。保存すると<strong>新しい版</strong>になります
        （過去の生成を後から再現できるようにするためです）。
      </p>
      <label className="block">
        <span className="text-base font-bold text-stone-700">基本構造</span>
        <textarea name="structure_notes" rows={4} defaultValue={structureNotes} className={AREA} />
      </label>
      <label className="block">
        <span className="text-base font-bold text-stone-700">残すもの</span>
        <textarea name="keep_rules" rows={4} defaultValue={keepRules} className={AREA} />
      </label>
      <label className="block">
        <span className="text-base font-bold text-stone-700">避けるもの</span>
        <textarea name="avoid_rules" rows={4} defaultValue={avoidRules} className={AREA} />
      </label>
      <label className="block">
        <span className="text-base font-bold text-stone-700">重要ルール</span>
        <textarea name="hard_rules" rows={4} defaultValue={hardRules} className={AREA} />
      </label>
      <button type="submit" disabled={isPending} className={`${BUTTON} bg-green-700 text-white`}>
        ✓ 新しい版として保存する
      </button>
      <Notice error={error} done={done} />
    </form>
  );
}

/** ⑧ 媒体の有効・非表示 */
export function ChannelToggleForm({
  channelId,
  enabled,
}: {
  channelId: string;
  enabled: boolean;
}) {
  const { isPending, error, done, run } = useAction();
  return (
    <div className="mt-2">
      <button
        type="button"
        disabled={isPending}
        onClick={() => {
          const fd = new FormData();
          fd.set("channel_id", channelId);
          if (!enabled) fd.set("enabled", "on");
          run(toggleChannelAction, fd, enabled ? "非表示にしました" : "有効にしました");
        }}
        className={`${BUTTON} ${
          enabled
            ? "border-2 border-stone-400 bg-white text-stone-700"
            : "bg-green-700 text-white"
        }`}
      >
        {enabled ? "✕ この媒体を使わない" : "✓ この媒体を使う"}
      </button>
      <Notice error={error} done={done} />
    </div>
  );
}

/** 写真ごとの確認フラグ（登録後にここで直せる） */
export function AssetFlagsForm({
  sourceId,
  assetId,
  caption,
  hasPerson,
  needsPublicCheck,
}: {
  sourceId: string;
  assetId: string;
  caption: string;
  hasPerson: boolean;
  needsPublicCheck: boolean;
}) {
  const { isPending, error, done, run } = useAction();
  return (
    <form
      action={(fd) => {
        fd.set("source_id", sourceId);
        fd.set("asset_id", assetId);
        run(setAssetFlagsAction, fd, "写真の設定を保存しました");
      }}
      className="mt-2 space-y-2"
    >
      <label className="block">
        <span className="text-base font-bold text-stone-700">この写真の説明</span>
        <input name="caption" defaultValue={caption} className={FIELD} />
      </label>
      <label className="flex min-h-[56px] items-center gap-3 rounded-xl bg-amber-50 px-3">
        <input
          type="checkbox"
          name="has_person"
          defaultChecked={hasPerson}
          className="h-6 w-6"
        />
        <span className="text-base font-bold text-amber-900">人物が写っている</span>
      </label>
      <label className="flex min-h-[56px] items-center gap-3 rounded-xl bg-amber-50 px-3">
        <input
          type="checkbox"
          name="needs_public_check"
          defaultChecked={needsPublicCheck}
          className="h-6 w-6"
        />
        <span className="text-base font-bold text-amber-900">公開してよいか確認が必要</span>
      </label>
      <button type="submit" disabled={isPending} className={`${BUTTON} border-2 border-stone-400 bg-white text-stone-700`}>
        ✎ この写真の設定を保存
      </button>
      <Notice error={error} done={done} />
    </form>
  );
}
