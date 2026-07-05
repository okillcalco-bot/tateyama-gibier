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
  | "summarize_meeting";

interface ModelConfig {
  model: string;
  maxTokens: number;
  temperature: number;
}

/**
 * ワークフローごとのモデル設定。
 * model を空にすると AI_DEFAULT_MODEL が使われる。
 * 例: 分類は軽量モデル、長文生成は上位モデル、のような使い分けをここで行う。
 */
const WORKFLOW_CONFIG: Record<WorkflowName, Partial<ModelConfig>> = {
  classify_voice_memo: { temperature: 0.1, maxTokens: 2048 },
  generate_grant_draft: { temperature: 0.3, maxTokens: 8192 },
  generate_nature_report: { temperature: 0.3, maxTokens: 8192 },
  summarize_meeting: { temperature: 0.2, maxTokens: 4096 },
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
    temperature: overrides.temperature ?? 0.2,
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
