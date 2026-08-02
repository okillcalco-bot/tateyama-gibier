import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";
import type { CrosspostDraftsOutput, FactSheetOutput } from "@/ai/schemas/crosspost.schema";
import { DEFAULT_CHANNELS, splitIntoBatches, type ChannelSpec } from "./channels";
import { listAssets, summarizeAssetFlags } from "./source-service";
import { markChannelsFailed, saveGeneratedDrafts } from "./draft-service";
import { getActiveStyle, FALLBACK_STYLE } from "./style-service";

/**
 * 下書き生成の段取り（0029）。
 *
 * 1. 事実整理を1回だけ実行して social_sources.fact_sheet に保存
 * 2. 媒体を2〜3件ずつのバッチに分けて生成
 * 3. **1バッチが失敗しても、成功したバッチの結果は残す**
 *    失敗した媒体だけ status='error' にして、その媒体だけ作り直せる
 *
 * AIの呼び出しは呼び出し側から注入する（domain は DbPort だけに依存する）。
 */

export interface AnalyzeFn {
  (input: { body: string; title?: string; category?: string; postedOn?: string }): Promise<{
    output: FactSheetOutput;
  }>;
}

export interface GenerateFn {
  (input: {
    body: string;
    factSheet: FactSheetOutput;
    channels: ChannelSpec[];
    style: {
      structure_notes: string;
      keep_rules: string;
      avoid_rules: string;
      hard_rules: string;
    };
    photoCaptions: string[];
  }): Promise<{ output: CrosspostDraftsOutput; draftId: string }>;
}

export interface GenerationDeps {
  db: DbPort;
  ctx: AuditContext;
  analyze: AnalyzeFn;
  generate: GenerateFn;
}

export interface GenerationResult {
  /** 生成できた媒体 */
  succeeded: string[];
  /** 失敗した媒体（その媒体だけ作り直せる） */
  failed: { channelKey: string; message: string }[];
  factSheet: FactSheetOutput | null;
}

/** DBの媒体設定を読む。行が無ければ既定値にフォールバック */
export async function loadChannelSpecs(
  db: DbPort,
  organizationId: string,
  options: { onlyEnabled?: boolean; keys?: string[] } = {},
): Promise<ChannelSpec[]> {
  const rows = await db.findMany("social_channels", { organization_id: organizationId }, 50);

  const specs: ChannelSpec[] =
    rows.length > 0
      ? rows.map((row) => ({
          key: String(row.channel_key) as ChannelSpec["key"],
          label: String(row.label),
          enabled: row.enabled !== false,
          sortOrder: Number(row.sort_order ?? 0),
          minChars: typeof row.min_chars === "number" ? row.min_chars : null,
          maxChars: typeof row.max_chars === "number" ? row.max_chars : null,
          maxHashtags: Number(row.max_hashtags ?? 0),
          ctaPolicy: String(row.cta_policy ?? ""),
          guidance: String(row.guidance ?? ""),
        }))
      : DEFAULT_CHANNELS;

  return specs
    .filter((spec) => (options.onlyEnabled === false ? true : spec.enabled))
    .filter((spec) => (options.keys ? options.keys.includes(spec.key) : true))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * 下書きを作る。channelKeys を渡すとその媒体だけ作り直す（部分再生成）。
 */
export async function generateDraftsForSource(
  deps: GenerationDeps,
  params: { sourceId: string; channelKeys?: string[] },
): Promise<GenerationResult> {
  const { db, ctx } = deps;

  const source = await db.findById("social_sources", params.sourceId);
  if (!source) throw new Error("元投稿が見つかりません");
  const body = typeof source.body === "string" ? source.body : "";
  if (!body) throw new Error("原文がありません");

  const specs = await loadChannelSpecs(db, ctx.organizationId, { keys: params.channelKeys });
  if (specs.length === 0) {
    throw new Error("有効な媒体がありません。設定画面で媒体を有効にしてください");
  }

  const assets = await listAssets(db, params.sourceId);
  const flags = summarizeAssetFlags(assets);

  const style = (await getActiveStyle(db, ctx.organizationId)) ?? {
    id: "",
    ...FALLBACK_STYLE,
  };

  // ── 1. 事実整理（1回だけ。すでにあれば使い回す） ──
  let factSheet: FactSheetOutput | null =
    (source.fact_sheet as FactSheetOutput | null) ?? null;

  if (!factSheet) {
    await db.update("social_sources", params.sourceId, { status: "analyzing" });
    const analyzed = await deps.analyze({
      body,
      title: typeof source.title === "string" ? source.title : undefined,
      category: typeof source.category === "string" ? source.category : undefined,
      postedOn: typeof source.posted_on === "string" ? source.posted_on : undefined,
    });
    factSheet = analyzed.output;
    await db.update("social_sources", params.sourceId, { fact_sheet: factSheet });
  }

  await db.update("social_sources", params.sourceId, { status: "generating" });

  // ── 2. 媒体をバッチに分けて生成（部分失敗に耐える） ──
  const succeeded: string[] = [];
  const failed: { channelKey: string; message: string }[] = [];

  for (const batch of splitIntoBatches(specs)) {
    const keys = batch.map((spec) => spec.key);
    try {
      const result = await deps.generate({
        body,
        factSheet,
        channels: batch,
        style: {
          structure_notes: style.structureNotes,
          keep_rules: style.keepRules,
          avoid_rules: style.avoidRules,
          hard_rules: style.hardRules,
        },
        photoCaptions: flags.captions,
      });

      const saved = await saveGeneratedDrafts(db, ctx, {
        sourceId: params.sourceId,
        aiGeneratedDraftId: result.draftId,
        drafts: result.output.drafts,
        specs: batch.map((spec) => ({
          key: spec.key,
          label: spec.label,
          maxChars: spec.maxChars,
        })),
        sourceBody: body,
        hasPersonPhoto: flags.hasPersonPhoto,
        needsPublicCheck: flags.needsPublicCheck,
        aiFlags: result.output.sensitive_flags,
        styleProfileId: style.id || null,
        styleVersion: style.version,
      });

      const savedKeys = saved.map((row) => String(row.channel_key));
      succeeded.push(...savedKeys);

      // AIが返さなかった媒体はエラー扱い（その媒体だけ作り直せる）
      const missing = keys.filter((key) => !savedKeys.includes(key));
      if (missing.length > 0) {
        await markChannelsFailed(db, ctx, {
          sourceId: params.sourceId,
          channelKeys: missing,
          message: "AIがこの媒体の下書きを返しませんでした",
        });
        failed.push(
          ...missing.map((key) => ({
            channelKey: key,
            message: "AIがこの媒体の下書きを返しませんでした",
          })),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成に失敗しました";
      await markChannelsFailed(db, ctx, {
        sourceId: params.sourceId,
        channelKeys: keys,
        message,
      });
      failed.push(...keys.map((key) => ({ channelKey: key, message })));
    }
  }

  await db.update("social_sources", params.sourceId, { status: "reviewing" });

  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "social_sources",
    recordId: params.sourceId,
    note: `媒体別の下書きを生成（成功 ${succeeded.length} / 失敗 ${failed.length}）`,
  });

  return { succeeded, failed, factSheet };
}

/** 元投稿の一覧に出す進み具合 */
export function summarizeProgress(drafts: Row[]): {
  total: number;
  approved: number;
  needsReview: number;
  published: number;
} {
  return {
    total: drafts.length,
    approved: drafts.filter((d) => d.status === "approved" || d.status === "queued").length,
    needsReview: drafts.filter((d) => d.status === "needs_review").length,
    published: drafts.filter((d) => d.status === "published").length,
  };
}
