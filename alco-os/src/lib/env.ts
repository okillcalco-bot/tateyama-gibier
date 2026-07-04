/**
 * 環境変数の一元管理。
 * ここ以外で process.env を直接読まないこと（モデル名・キーの散在防止）。
 */
export const env = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  aiProvider: process.env.AI_PROVIDER ?? "mock",
  aiDefaultModel: process.env.AI_DEFAULT_MODEL ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
};

/** Supabase が設定済みか（未設定ならセットアップ案内画面を出す） */
export function isSupabaseConfigured(): boolean {
  return Boolean(env.supabaseUrl && env.supabaseAnonKey);
}
