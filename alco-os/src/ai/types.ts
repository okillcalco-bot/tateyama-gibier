/**
 * AI プロバイダの共通インターフェース。
 * アプリ側は絶対にプロバイダSDKを直接呼ばない（必ず model-router 経由）。
 */

export interface CompletionRequest {
  /** システムプロンプト（prompts/ からロード） */
  system: string;
  /** ユーザー入力（構造化して渡す） */
  user: string;
  /** モデルID。model-router が解決する。プロバイダ側でのフォールバック禁止 */
  model: string;
  maxTokens?: number;
}

export interface CompletionResult {
  /** モデルの生テキスト出力（ワークフロー側で Zod パースする） */
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
