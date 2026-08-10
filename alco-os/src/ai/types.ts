/**
 * AI プロバイダの共通インターフェース。
 * アプリ側は絶対にプロバイダSDKを直接呼ばない（必ず model-router 経由）。
 */

/** 画像入力（レシート写真など）。base64はデータURLのプレフィックスを含めない */
export interface ImageInput {
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  base64: string;
}

export interface CompletionRequest {
  /** システムプロンプト（prompts/ からロード） */
  system: string;
  /** ユーザー入力（構造化して渡す） */
  user: string;
  /** モデルID。model-router が解決する。プロバイダ側でのフォールバック禁止 */
  model: string;
  maxTokens?: number;
  /** 画像を読ませる場合のみ（レシート読み取り等）。省略時は従来どおり文字だけ */
  images?: ImageInput[];
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
