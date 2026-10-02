// Supabase Edge Function の入口（Deno）。【本番未デプロイ】デプロイは本人の承認後。
// 必要な秘密値（Supabase の Edge Function Secrets に本人が登録する。リポジトリには置かない）:
//   SEAMALT_DB_URL       … 専用ロール seamalt_mcp の接続文字列（Supavisor 経由）
// 設定値（秘密ではない）:
//   SEAMALT_RESOURCE     … 例 https://clpdyrehdgzgiidbfucj.supabase.co/functions/v1/seamalt-mcp/mcp
//   SEAMALT_ISSUER       … 例 https://clpdyrehdgzgiidbfucj.supabase.co/auth/v1
//   SEAMALT_JWKS_URL     … 例 https://clpdyrehdgzgiidbfucj.supabase.co/auth/v1/.well-known/jwks.json
//   SEAMALT_AUDIENCES    … カンマ区切り（例: 上の RESOURCE。認可サーバーが resource を aud に入れない場合は要検討: docs/04-connect.md）
//   SEAMALT_CLIENT_IDS   … 許可する OAuth クライアントID（カンマ区切り。空なら制限なし＝非推奨）
//   SEAMALT_DETAIL_URL   … 受発注画面の ?order= 対応版が本番にあるときだけ https://tateyama-gibier.vercel.app/order-admin.html
// SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL は Edge Function に自動で入るが、このコードは読まない。
import pg from 'npm:pg@8.13.1';
import { createHandler } from './handler.mjs';
import { createDb } from './db.mjs';
import { createJwksCache } from './jwt.mjs';

const env = (k: string, d = '') => Deno.env.get(k) ?? d;
const list = (k: string) => env(k).split(',').map(s => s.trim()).filter(Boolean);

const pool = new pg.Pool({ connectionString: env('SEAMALT_DB_URL'), max: 3, idleTimeoutMillis: 10000 });
const config = {
  resource: env('SEAMALT_RESOURCE'),
  issuer: env('SEAMALT_ISSUER'),
  audiences: list('SEAMALT_AUDIENCES'),
  allowedClientIds: list('SEAMALT_CLIENT_IDS'),
  allowedAlgs: ['RS256', 'ES256'],
  maxTokenLifetimeSec: Number(env('SEAMALT_MAX_TOKEN_LIFETIME', '3600')),
  scopeSource: env('SEAMALT_SCOPE_SOURCE', 'principal'),   // Supabase OAuth はカスタムスコープを載せないため DB の principals で認可
  orgKey: 'tateyama-gibier',
  detailUrlBase: env('SEAMALT_DETAIL_URL') || null,
  version: '0.1.0',
};
const handler = createHandler({
  config,
  db: createDb(pool),
  jwks: createJwksCache({ jwksUrl: env('SEAMALT_JWKS_URL') }),
  // 構造化ログ（request_id・ツール名・結果だけ。引数・トークン・個人情報は出さない）
  log: (e: unknown) => console.log(JSON.stringify(e)),
});
Deno.serve(handler);
