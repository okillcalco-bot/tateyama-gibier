// シーモルト連携MCP（Streamable HTTP・JSON応答）。Web標準の Request/Response だけで書き、
// Supabase Edge Functions（Deno）でもローカルの Node でも同じコードが動く。
//
//   GET  /.well-known/oauth-protected-resource   … RFC 9728 の保護リソースメタデータ
//   POST /mcp                                      … JSON-RPC（initialize / tools/list / tools/call / ping）
//
// すべての /mcp 要求でアクセストークンを検証する。DBへは order_link.api_* だけを呼ぶ（db.callApi）。
// 返却値・ログに秘密値・トークン・メール全文を出さない。

import { validate } from './validate.mjs';
import { TOOLS, extraChecks, SERVER_INSTRUCTIONS } from './tools.mjs';
import { verifyAccessToken, AuthError } from './jwt.mjs';

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_BODY = 256 * 1024;
const OUTCOMES = new Set(['created', 'already_exists', 'needs_review', 'conflict', 'forbidden', 'failed', 'read']);

export function createHandler({ config, db, jwks, log = () => {}, now = () => Date.now(), randomId = () => crypto.randomUUID() }) {
  const resourceMetadataUrl = config.resource.replace(/\/mcp$/, '') + '/.well-known/oauth-protected-resource';
  const allScopes = ['orders:read', 'orders:import'];

  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
  const challenge = (err, desc, scope) =>
    `Bearer resource_metadata="${resourceMetadataUrl}"` + (err ? `, error="${err}", error_description="${desc.replace(/"/g, '')}"` : '') +
    (scope ? `, scope="${scope}"` : '');

  async function authenticate(req) {
    const h = req.headers.get('authorization') || '';
    const m = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(h);
    if (!m) throw new AuthError(null, 'authentication required');
    return verifyAccessToken(m[1], config, jwks, Math.floor(now() / 1000));
  }

  function toolResult(tool, requestId, dbResult) {
    const outcome = OUTCOMES.has(dbResult?.outcome) ? dbResult.outcome : 'failed';
    const order = dbResult?.order || null;
    const orderCode = order?.order_code || null;
    const common = {
      request_id: requestId,
      outcome,
      order_id: order?.order_id || null,
      order_code: orderCode,
      external_order_id: order?.external?.external_order_id ?? dbResult?.external_order_id ?? null,
      version: dbResult?.version ?? null,
      warnings: dbResult?.warnings || [],
      verified_at: dbResult?.verified_at || null,
      // 注文詳細へのリンクは、受発注画面が ?order= を開ける版が本番にあるときだけ返す（実在しないURLは返さない）
      detail_url: orderCode && config.detailUrlBase ? `${config.detailUrlBase}?order=${encodeURIComponent(orderCode)}` : null,
    };
    const structured = { ...dbResult, ...common };
    const isError = outcome === 'failed' || outcome === 'forbidden';
    const res = { content: [{ type: 'text', text: summarize(tool, structured) + '\n' + JSON.stringify(structured) }], structuredContent: structured, isError };
    if (outcome === 'forbidden' && /scope/.test(String(dbResult?.reason || ''))) {
      res._meta = { 'mcp/www_authenticate': [challenge('insufficient_scope', 'この操作の権限がありません', TOOLS.find(t => t.name === tool)?.scope)] };
    }
    return res;
  }

  async function callTool(params, auth, requestId) {
    const tool = TOOLS.find(t => t.name === params?.name);
    if (!tool) return { error: { code: -32602, message: 'unknown tool' } };
    const args = params.arguments ?? {};
    const errs = validate(tool.inputSchema, args);
    if (!errs.length) errs.push(...extraChecks(tool.name, args));
    if (errs.length) {
      log({ request_id: requestId, tool: tool.name, outcome: 'failed', reason: 'validation' });
      return { result: toolResult(tool.name, requestId, { outcome: 'failed', reason: 'validation_error', errors: errs }) };
    }
    // トークンにスコープが載る構成ではサーバーでも先に確認する（DBでも principals のスコープを確認する）
    if (Array.isArray(auth.scopes) && !auth.scopes.includes(tool.scope)) {
      return { result: toolResult(tool.name, requestId, { outcome: 'forbidden', reason: 'insufficient_scope' }) };
    }
    const ctx = { issuer: auth.issuer, subject: auth.subject, token_scopes: auth.scopes, org: config.orgKey, request_id: requestId };
    let out;
    try {
      out = await db.callApi(tool.fn, ctx, args);
    } catch (e) {
      // DBの詳細（値・個人情報を含みうる）は返さない。request_id で突き合わせる
      log({ request_id: requestId, tool: tool.name, outcome: 'failed', reason: 'db_error', sqlstate: e?.code || null });
      out = { outcome: 'failed', reason: 'internal_error', message: '処理に失敗しました。登録されたかは order_import_status で確認してください' };
    }
    log({ request_id: requestId, tool: tool.name, outcome: out?.outcome || 'failed' });
    return { result: toolResult(tool.name, requestId, out) };
  }

  async function rpc(msg, auth, protocol) {
    const requestId = randomId();
    switch (msg.method) {
      case 'initialize': {
        const v = SUPPORTED_PROTOCOLS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : SUPPORTED_PROTOCOLS[0];
        return { result: { protocolVersion: v, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'tateyama-gibier-orders', title: '館山ジビエ受発注（シーモルト連携）', version: config.version || '0.1.0' },
          instructions: SERVER_INSTRUCTIONS } };
      }
      case 'ping': return { result: {} };
      case 'tools/list':
        return { result: { tools: TOOLS.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
          annotations: t.annotations, securitySchemes: t.securitySchemes })) } };
      case 'tools/call': return callTool(msg.params, auth, requestId);
      default: return { error: { code: -32601, message: 'method not found' } };
    }
  }

  return async function handle(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/functions\/v1\/[^/]+/, '').replace(/^\/seamalt-mcp/, '') || '/';
    if (req.method === 'GET' && path === '/.well-known/oauth-protected-resource') {
      return json(200, { resource: config.resource, authorization_servers: [config.issuer], scopes_supported: allScopes,
        bearer_methods_supported: ['header'], resource_documentation: config.resourceDocumentation || undefined });
    }
    if (path !== '/mcp') return json(404, { error: 'not_found' });
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
    // ブラウザーからの呼出し（DNSリバインディング等）を拒否。サーバー間の呼出しは Origin を付けない
    const origin = req.headers.get('origin');
    if (origin && !(config.allowedOrigins || []).includes(origin)) return json(403, { error: 'origin_not_allowed' });
    const proto = req.headers.get('mcp-protocol-version');
    if (proto && !SUPPORTED_PROTOCOLS.includes(proto)) return json(400, { error: 'unsupported_protocol_version' });
    if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) return json(415, { error: 'content_type_must_be_json' });

    let auth;
    try { auth = await authenticate(req); }
    catch (e) {
      const code = e instanceof AuthError ? e.code : 'invalid_token';
      log({ outcome: 'unauthenticated', reason: code || 'missing_token' });
      return json(401, { error: code || 'unauthorized' }, { 'www-authenticate': challenge(code, e.description || 'authentication required') });
    }

    const raw = await req.text();
    if (raw.length > MAX_BODY) return json(413, { error: 'payload_too_large' });
    let body;
    try { body = JSON.parse(raw); } catch { return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    const batch = Array.isArray(body) ? body : [body];
    if (!batch.length || batch.length > 10) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
    const responses = [];
    for (const msg of batch) {
      if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        responses.push({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'invalid request' } });
        continue;
      }
      if (msg.id === undefined) continue;   // 通知（notifications/initialized 等）は応答しない
      const r = await rpc(msg, auth, proto);
      responses.push({ jsonrpc: '2.0', id: msg.id, ...r });
    }
    if (!responses.length) return new Response(null, { status: 202 });
    return json(200, Array.isArray(body) ? responses : responses[0]);
  };
}

// 会話に返す1行要約。「候補を保存」「受注に登録」「既存と一致」「要確認」を言い分ける
function summarize(tool, r) {
  const o = r.outcome;
  if (o === 'forbidden') return '権限がないため実行していません。';
  if (o === 'failed') return r.reason === 'validation_error' ? '入力が不正なため実行していません。' : '処理に失敗しました（何も登録していません）。';
  if (tool === 'orders_search') return `受注 ${r.total_count} 件中 ${r.returned} 件を返しました。${r.complete ? '検索は完了しています。' : '続きがあります（next_cursor）。'}`;
  if (tool === 'orders_get') return `注文 ${r.order_code || ''} を取得しました。`;
  if (tool === 'order_import_preview') {
    if (o === 'already_exists') return '同じ外部注文が同じ内容で登録済みです。新しい注文は作っていません。';
    if (o === 'conflict') return '既存の注文や候補と食い違いがあります（変更候補または古い版）。上書きしていません。';
    return r.commit_ready ? '取込候補を保存しました（受注にはまだ登録していません）。' : '取込候補を保存しました。登録の前に確認が必要な項目があります。';
  }
  if (tool === 'order_import_commit') {
    if (o === 'created') return `受注 ${r.order_code} として登録しました（在庫確保・出荷・請求はしていません）。orders_get で再確認してください。`;
    if (o === 'already_exists') return r.replayed ? '同じ冪等キーの登録は前回の結果のままです（重複して作っていません）。' : '既に登録済みの注文です（重複して作っていません）。';
    if (o === 'needs_review') return '確認が済んでいない項目があるため登録していません。';
    if (o === 'conflict') return '内容が食い違うため登録していません（上書きもしていません）。';
  }
  if (tool === 'order_import_status') return r.found ? `候補の状態: ${r.state}` : 'この取込の記録はありません。';
  return '';
}
