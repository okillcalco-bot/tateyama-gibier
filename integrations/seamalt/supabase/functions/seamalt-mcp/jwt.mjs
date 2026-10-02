// アクセストークン（JWT）の検証。署名（JWKS）・issuer・audience・期限・発行からの寿命・クライアントID・スコープを毎回確認する。
// 対称鍵（HS256）と alg=none は受け付けない。トークンの中身はログに出さない。

const ALGS = {
  RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  ES256: { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' },
};

export class AuthError extends Error {
  constructor(code, description) { super(description); this.code = code; this.description = description; }
}

function b64urlToBytes(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new AuthError('invalid_token', 'malformed token');
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : s.length % 4 === 1 ? null : '';
  if (pad === null) throw new AuthError('invalid_token', 'malformed token');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
function b64urlJson(s) {
  try { return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))); }
  catch (e) { throw new AuthError('invalid_token', 'malformed token'); }
}

// JWKS を取得してキャッシュする（既定10分）。知らない kid のときは1回だけ取り直す（30秒に1回まで）
export function createJwksCache({ jwksUrl, fetchImpl = fetch, ttlMs = 600000, now = () => Date.now() }) {
  let keys = null, fetchedAt = 0, lastForced = 0;
  async function load() {
    const res = await fetchImpl(jwksUrl, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new AuthError('temporarily_unavailable', 'jwks fetch failed');
    const body = await res.json();
    keys = Array.isArray(body.keys) ? body.keys : [];
    fetchedAt = now();
  }
  return {
    async get(kid) {
      if (!keys || now() - fetchedAt > ttlMs) await load();
      let k = keys.find(x => x.kid === kid);
      if (!k && now() - lastForced > 30000) { lastForced = now(); await load(); k = keys.find(x => x.kid === kid); }
      return k || null;
    },
  };
}

export async function verifyAccessToken(token, cfg, jwks, nowSec = Math.floor(Date.now() / 1000)) {
  if (!token || typeof token !== 'string' || token.length > 8192) throw new AuthError('invalid_token', 'missing or oversized token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('invalid_token', 'malformed token');
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  const alg = ALGS[header.alg];
  if (!alg || !(cfg.allowedAlgs || ['RS256', 'ES256']).includes(header.alg)) throw new AuthError('invalid_token', 'unsupported alg');
  if (!header.kid) throw new AuthError('invalid_token', 'missing kid');
  const jwk = await jwks.get(header.kid);
  if (!jwk) throw new AuthError('invalid_token', 'unknown signing key');
  if (jwk.use && jwk.use !== 'sig') throw new AuthError('invalid_token', 'key not for signing');
  const importAlg = header.alg === 'ES256' ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: alg.name, hash: alg.hash };
  const { kty, n, e, crv, x, y } = jwk;
  const key = await crypto.subtle.importKey('jwk', { kty, n, e, crv, x, y, ext: true }, importAlg, false, ['verify']);
  const verifyAlg = header.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: alg.name };
  const ok = await crypto.subtle.verify(verifyAlg, key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new AuthError('invalid_token', 'bad signature');

  const skew = cfg.clockSkewSec ?? 60;
  if (claims.iss !== cfg.issuer) throw new AuthError('invalid_token', 'issuer mismatch');
  const auds = [].concat(claims.aud || []);
  if (!auds.some(a => (cfg.audiences || []).includes(a))) throw new AuthError('invalid_token', 'audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp + skew < nowSec) throw new AuthError('invalid_token', 'token expired');
  if (typeof claims.nbf === 'number' && claims.nbf - skew > nowSec) throw new AuthError('invalid_token', 'token not yet valid');
  if (typeof claims.iat === 'number' && claims.iat - skew > nowSec) throw new AuthError('invalid_token', 'token issued in the future');
  if (cfg.maxTokenLifetimeSec && typeof claims.iat === 'number' && claims.exp - claims.iat > cfg.maxTokenLifetimeSec) {
    throw new AuthError('invalid_token', 'token lifetime too long');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) throw new AuthError('invalid_token', 'missing subject');
  if (cfg.allowedClientIds && cfg.allowedClientIds.length) {
    const cid = claims.client_id || claims.azp;
    if (!cfg.allowedClientIds.includes(cid)) throw new AuthError('invalid_token', 'client not allowed');
  }
  let scopes = null;
  if (cfg.scopeSource === 'token') {
    scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : Array.isArray(claims.scp) ? claims.scp : [];
  }
  return { issuer: claims.iss, subject: claims.sub, scopes, clientId: claims.client_id || claims.azp || null, exp: claims.exp };
}
