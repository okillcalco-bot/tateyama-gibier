import { env } from "@/lib/env";
import type { AiProvider } from "./types";
import { AnthropicProvider } from "./providers/anthropic-provider";
import { MockProvider } from "./providers/mock-provider";

/**
 * モデルルーター。
 * ワークフロー名 → (プロバイダ, モデル) の解決を一元管理する。
 *
 * ルール:
 * - アプリ内にモデル名をハードコードしない。変更はこのファイルと環境変数のみ。
 * - プロバイダ追加時は providers/ に実装を追加し、ここに登録する。
 */

export type WorkflowName =
  | "classify_voice_memo"
  | "generate_grant_draft"
  | "generate_nature_report"
  | "summarize_meeting"
  | "generate_presentation"
  | "generate_video_plan"
  | "generate_social_posts";

interface ModelConfig {
  model: string;
  maxTokens: number;
}

/**
 * ワークフローごとのモデル設定。
 * model を空にすると AI_DEFAULT_MODEL が使われる。
 * 例: 分類は軽量モデル、長文生成は上位モデル、のような使い分けをここで行う。
 * ※ temperature 等のサンプリングパラメータは最新モデルで廃止のため設定しない。
 */
const WORKFLOW_CONFIG: Record<WorkflowName, Partial<ModelConfig>> = {
  classify_voice_memo: { maxTokens: 2048 },
  generate_grant_draft: { maxTokens: 8192 },
  generate_nature_report: { maxTokens: 8192 },
  summarize_meeting: { maxTokens: 4096 },
  generate_presentation: { maxTokens: 12288 },
  generate_video_plan: { maxTokens: 12288 },
  generate_social_posts: { maxTokens: 8192 },
};

export function resolveModelConfig(workflow: WorkflowName): ModelConfig {
  const overrides = WORKFLOW_CONFIG[workflow] ?? {};
  const model = overrides.model ?? env.aiDefaultModel;
  if (!model && env.aiProvider !== "mock") {
    throw new Error(
      `モデル未設定: AI_DEFAULT_MODEL を設定するか、model-router で workflow "${workflow}" にモデルを指定してください`,
    );
  }
  return {
    model: model || "mock-model",
    maxTokens: overrides.maxTokens ?? 4096,
  };
}

/** プロバイダの解決。テストでは getProvider を使わず MockProvider を直接注入する。 */
export function getProvider(): AiProvider {
  switch (env.aiProvider) {
    case "anthropic":
      if (!env.anthropicApiKey) {
        throw new Error("ANTHROPIC_API_KEY が未設定です");
      }
      return new AnthropicProvider(env.anthropicApiKey);
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`未知の AI_PROVIDER: ${env.aiProvider}`);
  }
}
