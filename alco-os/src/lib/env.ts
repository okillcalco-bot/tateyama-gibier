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
  /**
   * LINE Messaging API（/api/line）。
   * 既存の LINE_CHANNEL_* は「秘書チャネル」のフォールバックとして残す
   * （設定済みのVercel環境変数を壊さないため）。
   */
  lineChannelSecret: read(process.env.LINE_CHANNEL_SECRET),
  lineChannelAccessToken: read(process.env.LINE_CHANNEL_ACCESS_TOKEN),
  /**
   * 秘書チャネル（沖代表の秘書用LINE公式アカウント）。
   * 未設定なら LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN を使う。
   * channelId は webhook の destination（Bot User ID）。未設定でも動作する
   * （destination の照合をスキップするだけ。署名検証は常に行う）。
   */
  lineSecretaryChannelId: read(process.env.LINE_SECRETARY_CHANNEL_ID),
  lineSecretaryChannelSecret:
    read(process.env.LINE_SECRETARY_CHANNEL_SECRET) || read(process.env.LINE_CHANNEL_SECRET),
  lineSecretaryAccessToken:
    read(process.env.LINE_SECRETARY_CHANNEL_ACCESS_TOKEN) ||
    read(process.env.LINE_CHANNEL_ACCESS_TOKEN),
  /**
   * 捕獲者チャネル（館山ジビエセンターの捕獲者向けLINE公式アカウント）。
   * GASへは転送せず、ALCO OS が受信・返信を担当する。
   */
  lineHunterChannelId: read(process.env.LINE_HUNTER_CHANNEL_ID),
  lineHunterChannelSecret: read(process.env.LINE_HUNTER_CHANNEL_SECRET),
  lineHunterAccessToken: read(process.env.LINE_HUNTER_CHANNEL_ACCESS_TOKEN),
  /** 既存のGAS秘書システムへLINE webhookを転送する場合のURL（任意） */
  gasWebhookUrl: read(process.env.GAS_WEBHOOK_URL),
  /**
   * 既存ジビエ基幹アプリ（ルートの静的PWA）の公開URL。
   * 市役所提出用「有害鳥獣捕獲票」は既存の capture-form.html?cityform= を
   * そのまま使うため、そこへのリンク生成に必要（任意。未設定なら手順を表示）。
   * 本番値: https://tateyama-gibier.vercel.app
   */
  gibierAppUrl: read(process.env.NEXT_PUBLIC_GIBIER_APP_URL).replace(/\/$/, ""),
  /** 公開URL（応援リンクの生成に使う。Vercelが自動で入れる本番ドメイン） */
  siteUrl: read(
    process.env.NEXT_PUBLIC_SITE_URL ||
      (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : ""),
  ),
};

/** Supabase が設定済みか（未設定ならセットアップ案内画面を出す） */
export function isSupabaseConfigured(): boolean {
  return Boolean(env.supabaseUrl && env.supabaseAnonKey);
}
