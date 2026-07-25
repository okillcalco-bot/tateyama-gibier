import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/**
 * 調査クエスト（ゲーミフィケーション）。
 *
 * 「有限のタスクは100%達成可能にする。生態系理解には100%を置かない」
 * （里山OS 設計書 10章）を実装する。
 *
 * 絶対ルール:
 * - restricted（希少種を含む）クエストは公開・募集・応援の対象にしない
 * - 進捗は観察記録の実績から算出する（自己申告のポイント稼ぎにしない）
 * - 位置情報はクエストに含めない（公開ページに座標を出さない）
 */

export interface QuestProgress {
  targetCount: number;
  progressCount: number;
  percent: number; // 0〜100
  completed: boolean;
  fundingGoalYen: number;
  fundedYen: number;
  fundedPercent: number;
  paidOutYen: number;
  /** 応援金のうち、まだ調査に充てていない残り */
  availableYen: number;
}

export function questProgress(task: Row): QuestProgress {
  const targetCount = Math.max(1, Number(task.target_count) || 1);
  const progressCount = Math.max(0, Number(task.progress_count) || 0);
  const fundingGoalYen = Math.max(0, Number(task.funding_goal_yen) || 0);
  const fundedYen = Math.max(0, Number(task.funded_yen) || 0);
  const paidOutYen = Math.max(0, Number(task.paid_out_yen) || 0);
  return {
    targetCount,
    progressCount,
    percent: Math.min(100, Math.round((progressCount / targetCount) * 100)),
    completed: progressCount >= targetCount,
    fundingGoalYen,
    fundedYen,
    fundedPercent:
      fundingGoalYen > 0 ? Math.min(100, Math.round((fundedYen / fundingGoalYen) * 100)) : 0,
    paidOutYen,
    availableYen: Math.max(0, fundedYen - paidOutYen),
  };
}

/** URL用スラッグ（公開ページの識別子）。日本語は id 断片で代替する */
export function toSlug(title: string, seed: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);
  const suffix = seed.replace(/-/g, "").slice(0, 6);
  return ascii ? `${ascii}-${suffix}` : `quest-${suffix}`;
}

export interface NewQuest {
  title: string;
  story?: string;
  siteId?: string | null;
  taxonGroup?: string | null;
  season?: string | null;
  method?: string | null;
  targetCount: number;
  fundingGoalYen?: number;
  rewardTitle?: string | null;
  priority?: number;
  restricted?: boolean;
}

export async function createQuest(
  db: DbPort,
  ctx: AuditContext,
  input: NewQuest,
): Promise<Row> {
  if (!input.title.trim()) throw new Error("クエスト名を入力してください");
  if (input.targetCount < 1) throw new Error("目標件数は1件以上にしてください");
  if ((input.fundingGoalYen ?? 0) < 0) throw new Error("必要資金が不正です");

  const quest = await db.insert("survey_tasks", {
    organization_id: ctx.organizationId,
    title: input.title.trim(),
    story: input.story?.trim() || null,
    site_id: input.siteId ?? null,
    taxon_group: input.taxonGroup ?? null,
    season: input.season ?? null,
    method: input.method ?? null,
    target_count: input.targetCount,
    progress_count: 0,
    funding_goal_yen: input.fundingGoalYen ?? 0,
    funded_yen: 0,
    paid_out_yen: 0,
    reward_title: input.rewardTitle?.trim() || null,
    priority: input.priority ?? 50,
    restricted: input.restricted ?? false,
    status: "open",
    source_type: "manual",
    created_by: ctx.actorId,
  });

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "survey_tasks",
    recordId: quest.id as string,
    after: quest,
    note: `クエスト作成: ${input.title}`,
  });
  return quest;
}

/**
 * クエストの公開（応援の受付開始）。
 * 希少種を含むクエストは公開できない（位置暴露・乱獲の誘発を防ぐ）。
 */
export async function publishQuest(db: DbPort, ctx: AuditContext, questId: string): Promise<Row> {
  const quest = await db.findById("survey_tasks", questId);
  if (!quest) throw new Error(`クエストが見つかりません: ${questId}`);
  if (quest.restricted) {
    throw new Error(
      "希少種を含むクエストは公開できません（位置情報の保護のため、認定調査者への個別依頼にしてください）",
    );
  }
  if (quest.published_at) return quest;

  const slug = (quest.public_slug as string) || toSlug(quest.title as string, quest.id as string);
  const after = await db.update("survey_tasks", questId, {
    public_slug: slug,
    published_at: new Date().toISOString(),
  });
  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "survey_tasks",
    recordId: questId,
    before: quest,
    after,
    note: `クエスト公開（応援受付開始）: ${quest.title}`,
  });
  return after;
}

export async function unpublishQuest(db: DbPort, ctx: AuditContext, questId: string): Promise<Row> {
  const quest = await db.findById("survey_tasks", questId);
  if (!quest) throw new Error(`クエストが見つかりません: ${questId}`);
  const after = await db.update("survey_tasks", questId, { published_at: null });
  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "survey_tasks",
    recordId: questId,
    before: quest,
    after,
    note: "クエスト公開停止",
  });
  return after;
}

/**
 * 進捗の記録（観察記録が増えたときに呼ぶ）。
 * 自己申告ではなく実績に基づく件数を渡すこと。
 */
export async function updateQuestProgress(
  db: DbPort,
  ctx: AuditContext,
  questId: string,
  progressCount: number,
): Promise<Row> {
  const quest = await db.findById("survey_tasks", questId);
  if (!quest) throw new Error(`クエストが見つかりません: ${questId}`);
  const target = Math.max(1, Number(quest.target_count) || 1);
  const next = Math.max(0, Math.floor(progressCount));
  const completed = next >= target;

  const after = await db.update("survey_tasks", questId, {
    progress_count: next,
    status: completed ? "done" : "open",
    completed_at: completed ? (quest.completed_at ?? new Date().toISOString()) : null,
  });
  if (completed && !quest.completed_at) {
    await writeAuditLog(db, ctx, {
      action: "update",
      tableName: "survey_tasks",
      recordId: questId,
      before: quest,
      after,
      note: `クエスト達成: ${quest.title}（${next}/${target}）`,
    });
  }
  return after;
}
