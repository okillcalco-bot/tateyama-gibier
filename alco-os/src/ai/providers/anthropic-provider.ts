import Anthropic from "@anthropic-ai/sdk";
import type { AiProvider, CompletionRequest, CompletionResult } from "../types";

/** Anthropic Claude API プロバイダ。モデル名は model-router から渡される。 */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // temperature 等のサンプリングパラメータは最新モデル（claude-sonnet-5 /
    // opus-4.7以降）で廃止されており、送ると 400 になるため指定しない
    const response = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}
