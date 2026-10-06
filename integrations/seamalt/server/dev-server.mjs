// ローカル確認用の Node サーバー（MCP Inspector から http://localhost:8787/mcp で叩ける）。本番では使わない。
// 使い方: SEAMALT_DB_URL=postgres://... SEAMALT_ISSUER=... SEAMALT_JWKS_URL=... node server/dev-server.mjs
import http from 'node:http';
import pg from 'pg';
import { createHandler } from '../supabase/functions/seamalt-mcp/handler.mjs';
import { createDb } from '../supabase/functions/seamalt-mcp/db.mjs';
import { createJwksCache } from '../supabase/functions/seamalt-mcp/jwt.mjs';

const port = Number(process.env.PORT || 8787);
const handler = createHandler({
  config: {
    resource: `http://localhost:${port}/mcp`, issuer: process.env.SEAMALT_ISSUER, audiences: [`http://localhost:${port}/mcp`],
    allowedAlgs: ['RS256', 'ES256'], maxTokenLifetimeSec: 3600, scopeSource: 'principal', orgKey: 'tateyama-gibier', detailUrlBase: null,
  },
  db: createDb(new pg.Pool({ connectionString: process.env.SEAMALT_DB_URL })),
  jwks: createJwksCache({ jwksUrl: process.env.SEAMALT_JWKS_URL }),
  log: e => console.log(JSON.stringify(e)),
});
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await handler(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`seamalt-mcp dev on http://localhost:${port}/mcp`));
