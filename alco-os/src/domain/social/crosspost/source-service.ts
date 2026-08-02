import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/**
 * 元のFB投稿（一次原稿）の登録（0029）。
 *
 * - 重複登録の主判定は**FB投稿URL**（unique index）
 * - 投稿番号 #連番 は重複してもエラーにせず、**警告として返す**
 * - 写真は Storage(alco-os) + files に入れ、ここでは順番と確認フラグだけ持つ
 */

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
] as const;

export interface NewSourceInput {
  sourceUrl?: string | null;
  sourceNo?: string | null;
  title?: string | null;
  body: string;
  postedOn?: string | null;
  category?: string | null;
  visibility?: string | null;
  relatedProjectId?: string | null;
  note?: string | null;
}

/** 原文の先頭にある【…#12】から投稿番号を拾う。無ければ null */
export function extractSourceNo(body: string): string | null {
  const match = body.match(/[#＃]\s*(\d{1,5})/);
  return match ? match[1] : null;
}

/** FB投稿URLの正規化（クエリを落として比較しやすくする） */
export function normalizeSourceUrl(url: string | null | undefined): string | null {
  const value = (url ?? "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

export interface CreateSourceResult {
  source: Row;
  /** 投稿番号が既存と重なっているときの注意（登録は止めない） */
  warnings: string[];
}

export async function createSource(
  db: DbPort,
  ctx: AuditContext,
  input: NewSourceInput,
): Promise<CreateSourceResult> {
  const body = input.body.trim();
  if (!body) throw new Error("原文を入力してください");

  const sourceUrl = normalizeSourceUrl(input.sourceUrl);
  const warnings: string[] = [];

  // 重複登録の主判定：同じFB投稿URL
  if (sourceUrl) {
    const existing = await db.findMany(
      "social_sources",
      { organization_id: ctx.organizationId, source_url: sourceUrl },
      1,
    );
    if (existing[0]) {
      throw new Error("この投稿URLはすでに登録されています");
    }
  }

  const sourceNo = (input.sourceNo ?? "").trim() || extractSourceNo(body);
  if (sourceNo) {
    const sameNo = await db.findMany(
      "social_sources",
      { organization_id: ctx.organizationId, source_no: sourceNo },
      5,
    );
    if (sameNo.length > 0) {
      warnings.push(
        `投稿番号 #${sourceNo} は既に${sameNo.length}件登録されています（登録は続けられます）`,
      );
    }
  }

  const source = await db.insert("social_sources", {
    organization_id: ctx.organizationId,
    source_url: sourceUrl,
    source_no: sourceNo,
    title: (input.title ?? "").trim() || null,
    body,
    posted_on: input.postedOn || null,
    category: input.category || null,
    visibility: input.visibility || null,
    related_project_id: input.relatedProjectId || null,
    note: (input.note ?? "").trim() || null,
    status: "inbox",
    created_by: ctx.actorId,
  });

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "social_sources",
    recordId: source.id as string,
    after: source,
    note: "FB投稿を横展開の元原稿として登録",
  });

  return { source, warnings };
}

export interface AttachAssetInput {
  sourceId: string;
  fileId: string;
  caption?: string | null;
  hasPerson?: boolean;
  needsPublicCheck?: boolean;
}

/** 写真・動画を紐づける（順番は追加順） */
export async function attachAsset(
  db: DbPort,
  ctx: AuditContext,
  input: AttachAssetInput,
): Promise<Row> {
  const existing = await db.findMany(
    "social_source_assets",
    { social_source_id: input.sourceId, file_id: input.fileId },
    1,
  );
  if (existing[0]) return existing[0];

  const all = await db.findMany(
    "social_source_assets",
    { social_source_id: input.sourceId },
    100,
  );

  return db.insert("social_source_assets", {
    organization_id: ctx.organizationId,
    social_source_id: input.sourceId,
    file_id: input.fileId,
    sort_order: all.length,
    caption: (input.caption ?? "").trim() || null,
    has_person: input.hasPerson === true,
    needs_public_check: input.needsPublicCheck === true,
    created_by: ctx.actorId,
  });
}

export async function listAssets(db: DbPort, sourceId: string): Promise<Row[]> {
  const rows = await db.findMany("social_source_assets", { social_source_id: sourceId }, 100);
  return rows.sort(
    (a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0),
  );
}

/** 写真の「人物あり」「公開確認が必要」をまとめる（要確認の判定に使う） */
export function summarizeAssetFlags(assets: Row[]): {
  hasPersonPhoto: boolean;
  needsPublicCheck: boolean;
  captions: string[];
} {
  return {
    hasPersonPhoto: assets.some((a) => a.has_person === true),
    needsPublicCheck: assets.some((a) => a.needs_public_check === true),
    captions: assets.map((a) =>
      typeof a.caption === "string" && a.caption ? a.caption : "（説明なし）",
    ),
  };
}

/** 写真ごとの「人物あり」「公開確認が必要」を職員が直す */
export async function setAssetFlags(
  db: DbPort,
  ctx: AuditContext,
  params: {
    assetId: string;
    hasPerson: boolean;
    needsPublicCheck: boolean;
    caption?: string | null;
  },
): Promise<Row> {
  const before = await db.findById("social_source_assets", params.assetId);
  if (!before) throw new Error("写真が見つかりません");
  if (before.organization_id !== ctx.organizationId) {
    throw new Error("他の組織の写真は変更できません");
  }

  const after = await db.update("social_source_assets", params.assetId, {
    has_person: params.hasPerson,
    needs_public_check: params.needsPublicCheck,
    caption:
      params.caption === undefined ? (before.caption ?? null) : (params.caption ?? "").trim() || null,
  });

  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "social_source_assets",
    recordId: params.assetId,
    before,
    after,
    note: `写真の確認フラグを更新（人物 ${params.hasPerson ? "あり" : "なし"} / 公開確認 ${
      params.needsPublicCheck ? "必要" : "不要"
    }）`,
  });

  return after;
}
