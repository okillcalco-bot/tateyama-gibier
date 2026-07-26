/**
 * LINE Messaging API クライアント（最小限）。
 *
 * ルール:
 * - アクセストークンは引数で受け取り、ログ・エラーメッセージへ出さない
 * - 例外を投げない（webhook を失敗させないため）。結果オブジェクトを返す
 * - replyToken は1イベントにつき1回のみ。呼び出し側で二重送信を防ぐこと
 */

const LINE_API = "https://api.line.me/v2/bot";

/** LINEのテキストメッセージ上限は5000文字 */
const MAX_TEXT_LENGTH = 4900;

export interface LineQuickReply {
  items: {
    type: "action";
    action: { type: "message"; label: string; text: string };
  }[];
}

export interface LineTextMessage {
  type: "text";
  text: string;
  quickReply?: LineQuickReply;
}

export interface LineSendResult {
  ok: boolean;
  /** 秘密情報を含まないエラー要約 */
  error?: string;
}

export function textMessage(text: string): LineTextMessage {
  const trimmed = text.trim();
  return {
    type: "text",
    text: trimmed.length > MAX_TEXT_LENGTH ? `${trimmed.slice(0, MAX_TEXT_LENGTH)}…` : trimmed,
  };
}

async function post(
  path: string,
  accessToken: string,
  payload: unknown,
): Promise<LineSendResult> {
  if (!accessToken) return { ok: false, error: "アクセストークン未設定" };
  try {
    const response = await fetch(`${LINE_API}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      // 本文にトークンは含まれないが、念のためステータスのみを返す
      return { ok: false, error: `LINE APIエラー（HTTP ${response.status}）` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "LINE APIへの接続に失敗しました" };
  }
}

/** 返信（無料枠。replyToken は1回のみ有効・約1分で失効） */
export async function replyMessage(
  accessToken: string,
  replyToken: string,
  messages: LineTextMessage[],
): Promise<LineSendResult> {
  if (!replyToken) return { ok: false, error: "replyToken がありません" };
  return post("/message/reply", accessToken, { replyToken, messages });
}

/** プッシュ送信（職員の明示操作でのみ使う。プランにより月間上限あり） */
export async function pushMessage(
  accessToken: string,
  to: string,
  messages: LineTextMessage[],
): Promise<LineSendResult> {
  if (!to) return { ok: false, error: "送信先が指定されていません" };
  return post("/message/push", accessToken, { to, messages });
}

/** 表示名の取得。失敗しても null を返すだけ（連携処理を止めない） */
export async function fetchDisplayName(
  accessToken: string,
  userId: string,
): Promise<string | null> {
  if (!accessToken || !userId) return null;
  try {
    const response = await fetch(`${LINE_API}/profile/${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { displayName?: unknown };
    return typeof data.displayName === "string" ? data.displayName : null;
  } catch {
    return null;
  }
}

/** クイックリプライの選択肢（押すとそのテキストが送信される） */
export interface QuickReplyChoice {
  label: string;
  text: string;
}

/**
 * 選択肢つきのテキストメッセージ。
 * 高齢の捕獲者が文字を打たずに1タップで答えられるようにする。
 * label は20文字までという制限があるため切り詰める。
 */
export function textMessageWithChoices(
  text: string,
  choices: QuickReplyChoice[],
): LineTextMessage {
  const base = textMessage(text);
  if (choices.length === 0) return base;
  return {
    ...base,
    quickReply: {
      items: choices.slice(0, 13).map((choice) => ({
        type: "action" as const,
        action: {
          type: "message" as const,
          label: choice.label.slice(0, 20),
          text: choice.text,
        },
      })),
    },
  };
}
