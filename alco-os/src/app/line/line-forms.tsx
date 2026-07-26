"use client";

import { useState, useTransition } from "react";
import type { ActionResult } from "@/lib/action-result";
import {
  blockLinkAction,
  sendHunterReplyAction,
  unblockLinkAction,
  verifyLinkAction,
} from "./actions";

/**
 * 捕獲者LINEの操作フォーム。
 * 現場は高齢の捕獲者・スタッフが多いため:
 *  - ボタンは高さ56px以上・文字は大きめ
 *  - 「はい/いいえ」ではなく、何が起きるかを書いたラベル
 *  - 状態は色だけでなく必ず文字でも示す
 */

const BUTTON_BASE =
  "w-full min-h-[56px] rounded-xl px-4 text-base font-bold disabled:opacity-50";

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
    <p className="mt-2 rounded-lg bg-red-50 p-2 text-base font-bold text-red-700">
      ⚠ {error}
    </p>
  );
}

export interface HunterOption {
  id: string;
  name: string;
  city: string | null;
}

/** 未確認のLINEユーザーを捕獲者に紐付ける */
export function VerifyLinkForm({
  linkId,
  hunters,
}: {
  linkId: string;
  hunters: HunterOption[];
}) {
  const { isPending, error, run } = useAction();
  const [hunterId, setHunterId] = useState("");

  return (
    <div className="mt-3 space-y-3">
      <label className="block">
        <span className="text-base font-bold text-stone-700">
          この人はどの捕獲者ですか
        </span>
        <select
          value={hunterId}
          onChange={(e) => setHunterId(e.target.value)}
          className="mt-1 w-full min-h-[56px] rounded-xl border-2 border-stone-300 bg-white px-3 text-base"
        >
          <option value="">えらんでください</option>
          {hunters.map((hunter) => (
            <option key={hunter.id} value={hunter.id}>
              {hunter.name}
              {hunter.city ? `（${hunter.city}）` : ""}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        disabled={isPending || !hunterId}
        onClick={() => {
          const formData = new FormData();
          formData.set("link_id", linkId);
          formData.set("hunter_id", hunterId);
          run(verifyLinkAction, formData);
        }}
        className={`${BUTTON_BASE} bg-green-700 text-white`}
      >
        ✓ この捕獲者として登録する
      </button>

      <button
        type="button"
        disabled={isPending}
        onClick={() => {
          const formData = new FormData();
          formData.set("link_id", linkId);
          run(blockLinkAction, formData);
        }}
        className={`${BUTTON_BASE} border-2 border-stone-400 bg-white text-stone-700`}
      >
        ✕ この相手からは受け取らない
      </button>

      <ErrorText error={error} />
    </div>
  );
}

/** 「受け取らない」の解除 */
export function UnblockLinkForm({ linkId }: { linkId: string }) {
  const { isPending, error, run } = useAction();
  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={isPending}
        onClick={() => {
          const formData = new FormData();
          formData.set("link_id", linkId);
          run(unblockLinkAction, formData);
        }}
        className={`${BUTTON_BASE} border-2 border-stone-400 bg-white text-stone-700`}
      >
        ↩ 受け取らない設定をやめる
      </button>
      <ErrorText error={error} />
    </div>
  );
}

/** 捕獲者へLINEで返信する（文面は職員が確認・編集してから送る） */
export function ReplyForm({
  linkId,
  messageId,
  suggestedReply,
  label = "返信する文章（送る前に必ず読んでください）",
}: {
  linkId: string;
  messageId?: string;
  suggestedReply: string;
  label?: string;
}) {
  const { isPending, error, run } = useAction();
  const [text, setText] = useState(suggestedReply);
  const [sent, setSent] = useState(false);

  return (
    <div className="mt-3 space-y-3">
      <label className="block">
        <span className="text-base font-bold text-stone-700">{label}</span>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSent(false);
          }}
          rows={4}
          className="mt-1 w-full rounded-xl border-2 border-stone-300 p-3 text-base"
          placeholder="例）ご連絡ありがとうございます。明日の午前中に受け入れできます。"
        />
      </label>
      <button
        type="button"
        disabled={isPending || !text.trim()}
        onClick={() => {
          const formData = new FormData();
          formData.set("link_id", linkId);
          if (messageId) formData.set("message_id", messageId);
          formData.set("reply_text", text);
          run(sendHunterReplyAction, formData);
          setSent(true);
          setText("");
        }}
        className={`${BUTTON_BASE} bg-green-700 text-white`}
      >
        📤 この文章をLINEで送る
      </button>
      {sent && !error && !isPending ? (
        <p className="rounded-lg bg-green-50 p-2 text-base font-bold text-green-800">
          ✓ 送信しました
        </p>
      ) : null}
      <ErrorText error={error} />
    </div>
  );
}
