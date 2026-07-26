import crypto from "node:crypto";
import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/**
 * 捕獲票の共有リンク（フェーズ3 / 要望3）。
 *
 * 捕獲者が自分で捕獲票を開いて印刷・PDF保存できるようにする。
 *
 * ルール:
 * - トークンは推測できない乱数（32文字）。期限は発行から30日
 * - 再発行すると前のリンクは即座に無効になる（職員が /gibier/reports から操作）
 * - 匿名で読めるのは「捕獲票に必要な列だけ」（0027 の SECURITY DEFINER 関数）
 */

export const SHARE_TOKEN_DAYS = 30;
export const SHARE_TOKEN_LENGTH = 32;

export function generateShareToken(): string {
  // base64url。記号が入らないのでURLに直接置ける
  return crypto.randomBytes(24).toString("base64url").slice(0, SHARE_TOKEN_LENGTH);
}

export function buildShareUrl(siteUrl: string, token: string): string {
  if (!siteUrl || !token) return "";
  return `${siteUrl.replace(/\/$/, "")}/hunter/city-form/${token}`;
}

export function isShareLinkValid(
  token: string | null | undefined,
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!token) return false;
  if (!expiresAt) return false;
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time > now.getTime();
}

/**
 * リンクを発行する（既にあれば作り直す = 前のリンクは無効になる）。
 * webhook からも職員画面からも呼ぶため、ctx は任意。
 */
export async function issueShareLink(
  db: DbPort,
  reportId: string,
  options: { ctx?: AuditContext; now?: Date } = {},
): Promise<{ token: string; expiresAt: string }> {
  const now = options.now ?? new Date();
  const token = generateShareToken();
  const expiresAt = new Date(
    now.getTime() + SHARE_TOKEN_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const before = await db.findById("capture_reports", reportId);
  const after = await db.update("capture_reports", reportId, {
    share_token: token,
    share_expires_at: expiresAt,
  });

  if (options.ctx) {
    await writeAuditLog(db, options.ctx, {
      action: "update",
      tableName: "capture_reports",
      recordId: reportId,
      // トークンそのものは監査ログに残さない
      note: before?.share_token
        ? "捕獲票の共有リンクを再発行（前のリンクは無効）"
        : "捕獲票の共有リンクを発行",
    });
  }

  return { token: after.share_token as string, expiresAt };
}

/** リンクを止める（トークンを消す） */
export async function revokeShareLink(
  db: DbPort,
  ctx: AuditContext,
  reportId: string,
): Promise<Row> {
  const before = await db.findById("capture_reports", reportId);
  if (!before) throw new Error("捕獲報告が見つかりません");

  const after = await db.update("capture_reports", reportId, {
    share_token: null,
    share_expires_at: null,
  });

  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "capture_reports",
    recordId: reportId,
    note: "捕獲票の共有リンクを無効にした",
  });

  return after;
}
