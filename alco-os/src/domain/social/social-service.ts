import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";
import { CHANNELS, type ChannelKey } from "@/ai/schemas/social.schema";

/**
 * 投稿一括更新の投稿管理。
 * 実際のSNS/HPへの自動投稿（Meta Graph API / YouTube Data API）は段階2。
 * ここでは「承認済み原稿のどのチャンネルを投稿済みにしたか」を管理する。
 * 外部公開に関わる操作なので必ず監査ログを残す。
 */
export async function markChannelPosted(
  db: DbPort,
  ctx: AuditContext,
  projectId: string,
  channel: ChannelKey,
): Promise<Row> {
  if (!CHANNELS[channel]) throw new Error(`不正なチャンネル: ${channel}`);
  const project = await db.findById("social_projects", projectId);
  if (!project) throw new Error(`案件が見つかりません: ${projectId}`);
  if (project.status === "brief" || !project.approved_content) {
    throw new Error("承認前の原稿は投稿済みにできません（承認センターで承認してください）");
  }
  const channels = (project.channels as string[]) ?? [];
  if (!channels.includes(channel)) {
    throw new Error(`この案件の対象チャンネルではありません: ${channel}`);
  }

  const posted = [...new Set([...((project.posted_channels as string[]) ?? []), channel])];
  const allPosted = channels.every((c) => posted.includes(c));
  const after = await db.update("social_projects", projectId, {
    posted_channels: posted,
    status: allPosted ? "posted" : "approved",
  });
  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "social_projects",
    recordId: projectId,
    before: project,
    after,
    note: `${CHANNELS[channel]} へ投稿済みにした`,
  });
  return after;
}
