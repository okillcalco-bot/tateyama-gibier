/**
 * 環境変数の一元管理。
 * ここ以外で process.env を直接読まないこと（モデル名・キーの散在防止）。
 * 値は必ず trim する（Vercel等への貼り付けで混入する末尾の改行・空白対策）。
 */
function read(value: string | undefined, fallback = ""): string {
  return (value ?? fallback).trim();
}

export const env = {
  supabaseUrl: read(process.env.NEXT_PUBLIC_SUPABASE_URL),
  supabaseAnonKey: read(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  supabaseServiceRoleKey: read(process.env.SUPABASE_SERVICE_ROLE_KEY),
  aiProvider: read(process.env.AI_PROVIDER, "mock") || "mock",
  aiDefaultModel: read(process.env.AI_DEFAULT_MODEL),
  anthropicApiKey: read(process.env.ANTHROPIC_API_KEY),
  /** 受信箱API（/api/inbox）の認証トークン。未設定なら受信箱は無効 */
  inboxToken: read(process.env.INBOX_TOKEN),
  /** LINE Messaging API（/api/line）。チャネルシークレットは署名検証に必須 */
  lineChannelSecret: read(process.env.LINE_CHANNEL_SECRET),
  lineChannelAccessToken: read(process.env.LINE_CHANNEL_ACCESS_TOKEN),
  /** 既存のGAS秘書システムへLINE webhookを転送する場合のURL（任意） */
  gasWebhookUrl: read(process.env.GAS_WEBHOOK_URL),
};

/** Supabase が設定済みか（未設定ならセットアップ案内画面を出す） */
export function isSupabaseConfigured(): boolean {
  return Boolean(env.supabaseUrl && env.supabaseAnonKey);
}
