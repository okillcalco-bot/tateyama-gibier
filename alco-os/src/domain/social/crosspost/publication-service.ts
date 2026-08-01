import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/**
 * 投稿履歴（0029 / Phase 1）。
 *
 * Phase 1 は**手動登録のみ**。外部投稿APIは実装しない。
 * 明示的な再投稿は Phase 2（repost_of_id / account_ref / revision /
 * idempotency_key の列は用意済み。Phase 1 では常に null）。
 *
 * 誤操作の二重登録は「同じ元投稿 × 同じ媒体で成功は1件」で防ぐ。
 */

export interface RecordPublicationInput {
  sourceId: string;
  draftId: string;
  postedUrl?: string | null;
  postedAt?: string | null;
  publisher?: string;
}

/**
 * 投稿済みの登録を1トランザクションで行う関数（0029 の
 * alco_crosspost_record_publication）。本番はこれを通す。
 */
export type RecordPublicationRpc = (params: {
  draftId: string;
  postedUrl: string | null;
  postedAt: string | null;
}) => Promise<Row>;

/**
 * 投稿済みとして登録する。
 *
 * 履歴の作成・下書きの状態更新・監査ログは**1トランザクション**で行う
 * （履歴だけ残って状態が変わらないと、unique制約で再登録できず
 *   履歴はRLSで更新も削除もできないため復旧が難しい）。
 *
 * rpc が渡されない場合（テストなど）は逐次処理にフォールバックする。
 */
export async function recordPublication(
  db: DbPort,
  ctx: AuditContext,
  input: RecordPublicationInput,
  rpc?: RecordPublicationRpc,
): Promise<Row> {
  const draft = await db.findById("social_channel_drafts", input.draftId);
  if (!draft) throw new Error("下書きが見つかりません");

  // 別の組織・別の元投稿の下書きを紐づけられないようにする（DBのトリガーと二重で確認）
  if (draft.organization_id !== ctx.organizationId) {
    throw new Error("他の組織の下書きは登録できません");
  }
  if (draft.social_source_id !== input.sourceId) {
    throw new Error("この下書きは別の元投稿のものです");
  }

  const channelKey = String(draft.channel_key);

  // ── 本番経路：DB関数で一体化 ──
  if (rpc) {
    return rpc({
      draftId: input.draftId,
      postedUrl: (input.postedUrl ?? "").trim() || null,
      postedAt: input.postedAt ?? null,
    });
  }

  // ── フォールバック（テスト用の逐次処理） ──
  // 誤操作の二重登録を先に弾く（Phase 1 は再投稿を扱わない）。
  // 状態チェックより先に見るのは、1回目の登録で status が published になり、
  // 2回目に「承認していない」という分かりにくい理由が出てしまうため。
  const existing = await db.findMany(
    "social_publications",
    { social_source_id: input.sourceId, channel_key: channelKey, result: "success" },
    1,
  );
  if (existing[0]) {
    throw new Error("この媒体はすでに投稿済みとして登録されています");
  }

  // 承認していないものを投稿済みにはできない
  if (draft.status !== "approved" && draft.status !== "queued") {
    throw new Error("承認していない下書きは投稿済みにできません");
  }
  const finalBody =
    typeof draft.approved_body === "string" ? draft.approved_body : "";
  if (!finalBody) throw new Error("承認した本文がありません");

  const publication = await db.insert("social_publications", {
    organization_id: ctx.organizationId,
    social_source_id: input.sourceId,
    social_channel_draft_id: input.draftId,
    channel_key: channelKey,
    final_body: finalBody,
    posted_url: (input.postedUrl ?? "").trim() || null,
    posted_at: input.postedAt || new Date().toISOString(),
    result: "success",
    publisher: input.publisher ?? "manual",
    // Phase 2 で使う列（Phase 1 では常に null）
    repost_of_id: null,
    account_ref: null,
    revision: null,
    idempotency_key: null,
    approved_by: draft.approved_by ?? null,
    approved_at: draft.approved_at ?? null,
    posted_by: ctx.actorId,
    created_by: ctx.actorId,
  });

  await db.update("social_channel_drafts", input.draftId, { status: "published" });

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "social_publications",
    recordId: publication.id as string,
    after: publication,
    note: `${channelKey} を投稿済みとして登録`,
  });

  return publication;
}

/** 失敗の記録（Phase 2 の publisher 用。Phase 1 では手動で使う想定はない） */
export async function recordPublicationFailure(
  db: DbPort,
  ctx: AuditContext,
  params: { sourceId: string; draftId: string; channelKey: string; message: string },
): Promise<Row> {
  const publication = await db.insert("social_publications", {
    organization_id: ctx.organizationId,
    social_source_id: params.sourceId,
    social_channel_draft_id: params.draftId,
    channel_key: params.channelKey,
    final_body: "",
    result: "failed",
    error_message: params.message,
    publisher: "manual",
    created_by: ctx.actorId,
  });

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "social_publications",
    recordId: publication.id as string,
    note: `${params.channelKey} の投稿に失敗: ${params.message}`,
  });

  return publication;
}

export async function listPublications(db: DbPort, sourceId: string): Promise<Row[]> {
  return db.findMany("social_publications", { social_source_id: sourceId }, 50);
}
