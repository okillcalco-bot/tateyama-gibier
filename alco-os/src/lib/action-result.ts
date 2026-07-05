/**
 * server action の結果型。
 * 本番の Next.js は server action が throw したエラーの内容をクライアントに
 * 渡さない（情報漏えい防止のためマスクされる）。そのためユーザーに見せる
 * べき業務エラー（権限なし・入力不備・設定不備など）は throw ではなく
 * この結果型で返すこと。
 */
export type ActionResult = { ok: true } | { ok: false; error: string };

/** 例外を ActionResult に変換する共通ラッパー */
export async function runAction(fn: () => Promise<void>): Promise<ActionResult> {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "エラーが発生しました" };
  }
}
