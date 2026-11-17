import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.mjs';

// Executa SQL real em SQLite e valida a autenticação com assinaturas RSA reais.
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const DB = { prepare(sql) { return { bind(...params) { return {
  async first() { return db.prepare(sql).get(...params) || null; },
  async all() { return { results: db.prepare(sql).all(...params) }; }
}; } }; } };
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'test', alg: 'RS256' };
const env = { DB, ACCESS_TEAM_DOMAIN: 'enem-teste.cloudflareaccess.com', ACCESS_AUD: 'app-teste' };
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
  assert.equal(url, 'https://enem-teste.cloudflareaccess.com/cdn-cgi/access/certs');
  return Response.json({ keys: [jwk] });
};
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function token(email, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const data = encode({ alg: 'RS256', kid: 'test' }) + '.' + encode({
    iss: 'https://' + env.ACCESS_TEAM_DOMAIN, aud: [env.ACCESS_AUD], sub: email,
    email, iat: now, exp: now + 3600, ...extra
  });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(data));
  return data + '.' + Buffer.from(signature).toString('base64url');
}
const alice = await token('alice@example.com'), bob = await token('bob@example.com');
async function request(path, jwt, body, extraHeaders = {}, method = body ? 'PUT' : 'GET') {
  const headers = { Origin: 'https://app.example.com', ...extraHeaders };
  if (jwt) headers['Cf-Access-Jwt-Assertion'] = jwt;
  if (body) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request('https://app.example.com' + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  }), env);
}
const key = 'historia|0|0|0', dates = ['16/11/2026', null, null];
const musicPath = '/audio/ferro-fumaca-e-revolucao.mp3';
const musicBytes = fs.readFileSync(new URL('./public' + musicPath, import.meta.url));
assert(musicBytes.length > 16, 'O arquivo de áudio deve conter dados para reprodução.');
assert.equal((await request(musicPath)).status, 401);
assert.equal((await request(musicPath, alice)).status, 503);
env.ASSETS = { async fetch(req) {
  assert.equal(new URL(req.url).pathname, musicPath);
  const partial = req.headers.has('Range');
  return new Response(req.method === 'HEAD' ? null : partial ? musicBytes.subarray(0, 16) : musicBytes, {
    status: partial ? 206 : 200,
    headers: { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes',
      ...(partial ? { 'Content-Range': `bytes 0-15/${musicBytes.length}` } : {}) }
  });
} };
const song = await request(musicPath, alice);
assert.equal(song.status, 200);
assert.equal(song.headers.get('Content-Type'), 'audio/mpeg');
assert.equal(song.headers.get('Cache-Control'), 'private, no-store');
assert.deepEqual(Buffer.from(await song.arrayBuffer()), musicBytes);
const segment = await request(musicPath, alice, undefined, { Range: 'bytes=0-15' });
assert.equal(segment.status, 206);
assert.equal(segment.headers.get('Content-Range'), `bytes 0-15/${musicBytes.length}`);
assert.equal((await segment.arrayBuffer()).byteLength, 16);
assert.equal(await (await request(musicPath, alice, undefined, {}, 'HEAD')).text(), '');
assert.equal((await request('/api/state')).status, 401);
assert.equal((await request('/api/state', await token('a@example.com', { exp: 1 }))).status, 401);
assert.equal((await request('/api/state', await token('a@example.com', { aud: ['outra-app'] }))).status, 401);
assert.equal((await request('/api/state', await token('a@example.com', { iss: 'https://outro.cloudflareaccess.com' }))).status, 401);
const forgedParts = alice.split('.');
forgedParts[1] = encode({ email: 'bob@example.com', iss: 'https://' + env.ACCESS_TEAM_DOMAIN, aud: [env.ACCESS_AUD], sub: 'bob', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 });
assert.equal((await request('/api/state', forgedParts.join('.'))).status, 401);
assert.equal((await worker.fetch(new Request('https://app.example.com/'), {})).status, 503);
// O YouTube exige a origem no Referer para reproduzir vídeos incorporados (erro 153).
for (const path of ['/', '/index.html']) {
  for (const method of ['GET', 'HEAD']) {
    const page = await request(path, alice, undefined, {}, method);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
    assert.equal(page.headers.get('Content-Security-Policy'), "frame-ancestors 'none'");
    if (method === 'GET') {
      assert.match(await page.text(), /<iframe\s+src="https:\/\/www\.youtube\.com\/embed\/[^\"]+"\s+title="[^\"]+"\s+referrerpolicy="strict-origin-when-cross-origin"/);
    } else {
      assert.equal(await page.text(), '');
    }
  }
}
assert.equal((await request('/api/revision', alice, { key, dates, version: 0 }, { Origin: 'https://outro.example.com' })).status, 403);
assert.equal((await request('/api/revision', alice, { key, dates: ['31/02/2026', null, null], version: 0 })).status, 400);
assert.equal((await request('/api/revision', alice, { key: 'invalido', dates, version: 0 })).status, 400);
assert.equal((await request('/api/revision', alice, { key, dates, version: 0, email: 'bob@example.com' })).status, 200);
let state = await (await request('/api/state', alice)).json();
assert.deepEqual(state.data[key], dates); assert.equal(state.versions[key], 1);
assert.deepEqual((await (await request('/api/state', bob)).json()).data, {});
assert.equal((await request('/api/revision', bob, { key, dates: [null, null, null], version: 1 })).status, 409);
assert.equal((await request('/api/revision', alice, { key, dates, version: 0 })).status, 409);
assert.equal((await request('/api/revision', alice, { key, dates: [null, null, null], version: 1 })).status, 200);
assert.equal((await request('/api/revision', alice, { key, dates, version: 1 })).status, 409);
state = await (await request('/api/state', alice)).json();
assert.deepEqual(state.data[key], [null, null, null]); assert.equal(state.versions[key], 2);
assert.equal((await request('/api/revision', bob, { key, dates, version: 0 })).status, 200);
assert.equal((await request('/api/revision', alice, { key, dates, version: 2, padding: 'x'.repeat(3000) })).status, 413);
const broken = { ...env, DB: { prepare() { throw new Error('Falha simulada'); } } };
assert.equal((await worker.fetch(new Request('https://app.example.com/api/state', { headers: { 'Cf-Access-Jwt-Assertion': alice } }), broken)).status, 500);
globalThis.fetch = originalFetch;
db.close();

// Verifica a interface: falha não vira confirmação, rascunho preservado e nova tentativa.
const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
assert.doesNotMatch(html, /localStorage|indexedDB|APPS_SCRIPT|script\.google\.com/);
const oldPath = new URL('./index.antes-nuvem.html.bak', import.meta.url);
if (fs.existsSync(oldPath)) {
  const old = fs.readFileSync(oldPath, 'utf8');
  for (const name of ['CURRICULUM', 'QUIZZES', 'DISC_ICONS']) {
    const pattern = new RegExp('const ' + name + ' = (.*);');
    assert.equal(html.match(pattern)?.[1], old.match(pattern)?.[1], name + ' preservado');
  }
}
const elements = new Map(), classes = new Map();
const element = id => {
  if (!elements.has(id)) {
    const set = new Set(); classes.set(id, set);
    elements.set(id, { style: {}, textContent: '', innerHTML: '', classList: {
      add(c) { set.add(c); }, remove(c) { set.delete(c); }, toggle(c) { set.has(c) ? set.delete(c) : set.add(c); }
    }});
  }
  return elements.get(id);
};
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/loadState\(\);\s*$/, '');
const ctx = vm.createContext({ console, AbortController, setTimeout: () => 1, clearTimeout() {},
  document: { getElementById: element, querySelectorAll: () => [] }, CSS: { escape: s => s },
  window: { addEventListener() {}, scrollTo() {}, location: { assign() {} } }, confirm: () => true,
  fetch: async () => Response.json({ email: 'alice@example.com', data: {}, versions: {} })
});
const run = s => vm.runInContext(s, ctx);
run(code); await run('loadState()'); assert.equal(run('cloudReady'), true);
run("openDiscipline('historia')");
const historyPage = element('appContainer').innerHTML;
assert(historyPage.indexOf('music-launch-card') > historyPage.indexOf('onclick="openVideos('));
assert.match(historyPage, /Músicas para revisão de História/);
run('openMusic()');
assert.equal(element('headerTitle').textContent, 'Músicas de História');
assert.match(element('appContainer').innerHTML, /Ferro, Fumaça e Revolução/);
assert.match(element('appContainer').innerHTML, /<audio controls preload="metadata"/);
assert.match(element('appContainer').innerHTML, /src="\/audio\/ferro-fumaca-e-revolucao.mp3"/);
run('goBack()');
assert.equal(run('currentView'), 'discipline');
assert.equal(run('selectedDisciplineId'), 'historia');
run("openDiscipline('geografia')");
assert.doesNotMatch(element('appContainer').innerHTML, /music-launch-card/);
run("openModal()"); assert(classes.get('backupModal').has('open'));
run("closeModal()"); assert(!classes.get('backupModal').has('open'));
run(`draftData['${key}'] = [true, false, false]`);
ctx.fetch = async () => { throw new TypeError('Offline'); };
await run(`saveSubtheme('${key}')`);
assert.equal(run(`savedData['${key}']`), undefined);
assert.equal(run(`draftData['${key}'][0]`), true);
assert.match(elements.get('toastBox').textContent, /não confirmado/);
ctx.fetch = async () => Response.json({ dates, version: 1 });
await run(`saveSubtheme('${key}')`);
assert.equal(run(`savedData['${key}'][0]`), dates[0]);
assert.equal(run(`draftData['${key}']`), undefined);
assert.match(elements.get('toastBox').textContent, /salva na nuvem/);
ctx.fetch = async () => Response.json({ error: 'Conflito em outro aparelho' }, { status: 409 });
run(`draftData['${key}'] = [false, false, false]`);
await run(`saveSubtheme('${key}')`);
assert.equal(run(`savedData['${key}'][0]`), dates[0]);
assert.equal(run(`draftData['${key}'][0]`), false);
ctx.fetch = async () => new Response('', { status: 401 });
await run('loadState()'); assert.equal(run('cloudReady'), false);
console.log('OK: RSA, tokens inválidos/expirados, isolamento por usuário, SQL real, conflitos entre aparelhos, desmarcação, validação, falhas de rede/banco e confirmação na interface.');
