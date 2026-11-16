// O arquivo pronto para a Cloudflare é gerado por preparar-cloudflare.cjs.
import { APP_HTML, VALID_KEYS } from './generated/app.mjs';

const validKeys = new Set(VALID_KEYS);
let keyCache = { issuer: '', until: 0, keys: [] };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Cookie, Cf-Access-Jwt-Assertion'
  }});
}

function decodePart(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), c => c.charCodeAt(0));
}

async function authenticate(request, env) {
  const domain = (env.ACCESS_TEAM_DOMAIN || '').replace(/^https:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) || !env.ACCESS_AUD) {
    throw new HttpError(503, 'Configure ACCESS_TEAM_DOMAIN e ACCESS_AUD no Worker.');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 16384) throw new HttpError(401, 'Entre novamente para acessar sua conta.');
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error();
    const header = JSON.parse(new TextDecoder().decode(decodePart(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(decodePart(parts[1])));
    const issuer = `https://${domain}`;
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' ||
        claims.iss !== issuer || !Array.isArray(claims.aud) || !claims.aud.includes(env.ACCESS_AUD) ||
        !Number.isFinite(claims.exp) || claims.exp <= now ||
        !Number.isFinite(claims.iat) || claims.iat > now + 30 ||
        (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30)) ||
        typeof claims.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(claims.email) || claims.email.length > 254 ||
        typeof claims.sub !== 'string' || !claims.sub) throw new Error();
    if (keyCache.issuer !== issuer || keyCache.until < Date.now() || !keyCache.keys.some(k => k.kid === header.kid)) {
      const response = await fetch(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const jwks = await response.json();
      if (!Array.isArray(jwks.keys)) throw new Error();
      keyCache = { issuer, until: Date.now() + 300000, keys: jwks.keys };
    }
    const jwk = keyCache.keys.find(k => k.kid === header.kid && k.kty === 'RSA');
    if (!jwk) throw new Error();
    const key = await crypto.subtle.importKey('jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const verified = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
      decodePart(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!verified) throw new Error();
    // A identidade vem exclusivamente do comprovante assinado pela Cloudflare.
    return claims.email.trim().toLowerCase();
  } catch {
    throw new HttpError(401, 'Não foi possível validar seu acesso. Entre novamente.');
  }
}

function validDates(value) {
  return Array.isArray(value) && value.length === 3 && value.every(date => {
    if (date === null) return true;
    if (typeof date !== 'string' || !/^\d{2}\/\d{2}\/\d{4}$/.test(date)) return false;
    const [d, m, y] = date.split('/').map(Number);
    const check = new Date(Date.UTC(y, m - 1, d));
    return y >= 2000 && y <= 2100 && check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const email = await authenticate(request, env);
      if (url.pathname.startsWith('/api/')) {
        if (!env.DB) throw new HttpError(503, 'Conecte o banco D1 com o nome DB.');
        if (url.pathname === '/api/state' && request.method === 'GET') {
          const result = await env.DB.prepare('SELECT item_key, dates_json, version FROM revisions WHERE user_email = ?').bind(email).all();
          const data = {}, versions = {};
          for (const row of result.results) {
            if (validKeys.has(row.item_key)) {
              data[row.item_key] = JSON.parse(row.dates_json);
              versions[row.item_key] = row.version;
            }
          }
          return json({ email, data, versions });
        }
        if (url.pathname === '/api/revision' && request.method === 'PUT') {
          if (request.headers.get('Origin') !== url.origin) throw new HttpError(403, 'Origem da solicitação inválida.');
          if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new HttpError(415, 'Envie os dados em JSON.');
          // Limita o corpo efetivamente recebido, mesmo sem Content-Length.
          const reader = request.body?.getReader();
          if (!reader) throw new HttpError(400, 'Dados ausentes.');
          let size = 0;
          const chunks = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 2048) { await reader.cancel(); throw new HttpError(413, 'Dados muito grandes.'); }
            chunks.push(value);
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          let body;
          try { body = JSON.parse(new TextDecoder().decode(bytes)); }
          catch { throw new HttpError(400, 'Dados inválidos.'); }
          if (!body || !validKeys.has(body.key) || !validDates(body.dates) ||
              !Number.isSafeInteger(body.version) || body.version < 0) throw new HttpError(400, 'Revisão inválida.');
          // Controle de versão evita sobrescrever uma alteração feita em outro aparelho.
          if (body.version > 0) {
            const updated = await env.DB.prepare(`UPDATE revisions SET dates_json = ?, version = version + 1,
              updated_at = CURRENT_TIMESTAMP WHERE user_email = ? AND item_key = ? AND version = ?
              RETURNING dates_json, version`).bind(JSON.stringify(body.dates), email, body.key, body.version).first();
            if (!updated) throw new HttpError(409, 'Esta revisão mudou em outro aparelho. Atualize os dados da nuvem e marque novamente.');
            return json({ dates: JSON.parse(updated.dates_json), version: updated.version });
          }
          const row = await env.DB.prepare(`INSERT INTO revisions (user_email, item_key, dates_json, version)
            VALUES (?, ?, ?, 1) ON CONFLICT(user_email, item_key) DO NOTHING
            RETURNING dates_json, version`).bind(email, body.key, JSON.stringify(body.dates)).first();
          if (!row) throw new HttpError(409, 'Esta revisão mudou em outro aparelho. Atualize os dados da nuvem e marque novamente.');
          return json({ dates: JSON.parse(row.dates_json), version: row.version });
        }
        throw new HttpError(404, 'Endereço não encontrado.');
      }
      if ((url.pathname === '/' || url.pathname === '/index.html') && (request.method === 'GET' || request.method === 'HEAD')) {
        return new Response(request.method === 'HEAD' ? null : APP_HTML, { headers: {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
          'Content-Security-Policy': "frame-ancestors 'none'"
        }});
      }
      throw new HttpError(404, 'Endereço não encontrado.');
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Falha no banco ou no Worker:', error.message);
      return json({ error: error instanceof HttpError ? error.message : 'Não foi possível acessar o banco. Tente novamente.' }, error.status || 500);
    }
  }
};
