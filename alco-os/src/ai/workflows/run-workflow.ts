import type { z } from "zod";
import type { AiProvider } from "../types";
import type { WorkflowName } from "../model-router";
import { resolveModelConfig } from "../model-router";
import type { DbPort, Row } from "@/lib/db/port";

/**
 * ワークフロー共通ランナー。
 * すべてのAIワークフローはここを通ることで、以下を強制する:
 *  1. ai_runs への実行ログ記録（成功・失敗とも）
 *  2. 出力の Zod バリデーション
 *  3. generated_drafts へのドラフト保存（業務テーブルへの直接書き込み禁止）
 */

export interface WorkflowContext {
  db: DbPort;
  provider: AiProvider;
  organizationId: string;
  userId: string | null;
}

export interface RunWorkflowParams<TOutput> {
  workflow: WorkflowName;
  promptVersion: string;
  system: string;
  user: string;
  // 入力型（zodの .default() 適用前）は問わないため第3型引数は unknown
  outputSchema: z.ZodType<TOutput, z.ZodTypeDef, unknown>;
  /** ai_runs.input_summary に入れる短い要約。個人情報の生データは渡さない */
  inputSummary: string;
  draft: {
    draftType: string;
    sourceTable?: string;
    sourceId?: string;
    title?: string;
  };
}

export interface WorkflowResult<TOutput> {
  output: TOutput;
  aiRunId: string;
  draftId: string;
}

/** モデル出力からJSONを取り出す（コードフェンス囲みにも耐える） */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate);
}

export async function runWorkflow<TOutput>(
  ctx: WorkflowContext,
  params: RunWorkflowParams<TOutput>,
): Promise<WorkflowResult<TOutput>> {
  const config = resolveModelConfig(params.workflow);
  const startedAt = Date.now();

  const baseRun: Row = {
    organization_id: ctx.organizationId,
    workflow: params.workflow,
    provider: ctx.provider.name,
    model: config.model,
    prompt_version: params.promptVersion,
    input_summary: params.inputSummary,
    created_by: ctx.userId,
  };

  let completion;
  try {
    completion = await ctx.provider.complete({
      system: params.system,
      user: params.user,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    });
  } catch (error) {
    await ctx.db.insert("ai_runs", {
      ...baseRun,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      latency_ms: Date.now() - startedAt,
    });
    throw error;
  }

  let output: TOutput;
  try {
    output = params.outputSchema.parse(extractJson(completion.text));
  } catch (error) {
    await ctx.db.insert("ai_runs", {
      ...baseRun,
      status: "failed",
      error: `出力バリデーション失敗: ${error instanceof Error ? error.message : String(error)}`,
      input_tokens: completion.inputTokens,
      output_tokens: completion.outputTokens,
      latency_ms: Date.now() - startedAt,
    });
    throw error;
  }

  const aiRun = await ctx.db.insert("ai_runs", {
    ...baseRun,
    status: "succeeded",
    input_tokens: completion.inputTokens,
    output_tokens: completion.outputTokens,
    latency_ms: Date.now() - startedAt,
  });

  const outputRecord = output as Record<string, unknown>;
  const draft = await ctx.db.insert("generated_drafts", {
    organization_id: ctx.organizationId,
    ai_run_id: aiRun.id,
    draft_type: params.draft.draftType,
    source_table: params.draft.sourceTable ?? null,
    source_id: params.draft.sourceId ?? null,
    title: params.draft.title ?? null,
    content: output,
    confidence: typeof outputRecord.confidence === "number" ? outputRecord.confidence : null,
    needs_human_review: true,
    warnings: Array.isArray(outputRecord.warnings) ? outputRecord.warnings : [],
    status: "draft",
    created_by: ctx.userId,
  });

  return { output, aiRunId: aiRun.id as string, draftId: draft.id as string };
}
