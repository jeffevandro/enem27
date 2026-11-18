import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.mjs';
import { SPEED_BANKS } from './generated/app.mjs';

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
const contact = { name: 'Ana', email: 'ana@example.com', message: 'Sugestão sobre o simulado.' };
const postContact = body => request('/api/contact', alice, body, {}, 'POST');
assert.equal((await postContact(contact)).status, 503);
env.CONTACT_FROM = 'app@example.com';
let sentMail;
env.CONTACT_MAIL = { async send(mail) { sentMail = mail; } };
assert.equal((await postContact({ ...contact, message: ' ' })).status, 400);
assert.deepEqual(await (await postContact(contact)).json(), { sent: true });
assert.equal(sentMail.to, 'jefferson.evandro@gmail.com');
assert.equal(sentMail.replyTo, contact.email);
assert.ok(sentMail.text.includes(contact.message));
env.CONTACT_MAIL.send = async () => { throw new Error('indisponível'); };
assert.equal((await postContact(contact)).status, 502);
for (const filename of fs.readdirSync(new URL('./public/audio/', import.meta.url)).filter(name => name.endsWith('.mp3'))) {
const musicPath = '/audio/' + filename;
delete env.ASSETS;
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
}
// Testa o mesmo arquivo que o álbum solicita, inclusive após trocas de imagem.
const albumHtml = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const stickerPath = '/figurinhas/zumbi-dos-palmares.jpg';
const stickerBytes = fs.readFileSync(new URL('./public' + stickerPath, import.meta.url));
assert.equal(stickerBytes.readUInt16BE(0), 0xffd8);
assert.equal((await request(stickerPath)).status, 401);
const audioAssets = env.ASSETS;
env.ASSETS = { async fetch(req) {
  assert.equal(new URL(req.url).pathname, stickerPath);
  return new Response(req.method === 'HEAD' ? null : stickerBytes, { headers: { 'Content-Type': 'image/jpeg' } });
} };
const stickerResponse = await request(stickerPath, alice);
assert.equal(stickerResponse.status, 200);
assert.equal(stickerResponse.headers.get('Content-Type'), 'image/jpeg');
assert.equal(stickerResponse.headers.get('Cache-Control'), 'private, no-store');
assert.deepEqual(Buffer.from(await stickerResponse.arrayBuffer()), stickerBytes);
assert.equal(await (await request(stickerPath, alice, undefined, {}, 'HEAD')).text(), '');
env.ASSETS = audioAssets;
const miltonBytes = fs.readFileSync(new URL('./public/figurinhas/milton-santos.jpg', import.meta.url));
assert.equal(miltonBytes.readUInt16BE(0), 0xffd8);
assert.equal((await request('/figurinhas/milton-santos.jpg')).status, 401);
env.ASSETS = { async fetch(req) {
  assert.equal(new URL(req.url).pathname, '/figurinhas/milton-santos.jpg');
  return new Response(req.method === 'HEAD' ? null : miltonBytes, { headers: { 'Content-Type': 'image/jpeg' } });
} };
assert.deepEqual(Buffer.from(await (await request('/figurinhas/milton-santos.jpg', alice)).arrayBuffer()), miltonBytes);
assert.equal(await (await request('/figurinhas/milton-santos.jpg', alice, undefined, {}, 'HEAD')).text(), '');
env.ASSETS = audioAssets;
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
for (const discipline of ['historia', 'geografia']) {
  const award = { discipline, elapsedMs: 149999, answers: SPEED_BANKS[discipline].slice(0, 10).map(q => ({ id: q.id, answer: q.answer })) };
  assert.equal((await request('/api/sticker', alice, { ...award, elapsedMs: 150001 })).status, 400);
  assert.equal((await request('/api/sticker', alice, { ...award, answers: award.answers.slice(0, 9) })).status, 400);
  assert.equal((await request('/api/sticker', alice, { ...award, answers: Array(10).fill(award.answers[0]) })).status, 400);
  assert.equal((await request('/api/sticker', alice, { ...award, answers: award.answers.map(a => ({ ...a, answer: 'X' })) })).status, 400);
  assert.equal((await request('/api/sticker', alice, award, { Origin: 'https://other.example.com' })).status, 403);
  assert.equal((await request('/api/sticker', alice, award)).status, 200);
  assert.equal((await request('/api/sticker', alice, award)).status, 200);
}
state = await (await request('/api/state', alice)).json();
assert.deepEqual(state.stickers, { historia: true, geografia: true });
assert.equal(state.data['sticker|geografia'], undefined);
assert.deepEqual((await (await request('/api/state', bob)).json()).stickers, {});
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
    elements.set(id, { style: {}, textContent: '', innerHTML: '', focus() {}, showModal() { this.open = true; }, close() { this.open = false; }, querySelectorAll: () => [], classList: {
      add(c) { set.add(c); }, remove(c) { set.delete(c); }, toggle(c) { set.has(c) ? set.delete(c) : set.add(c); }
    }});
  }
  return elements.get(id);
};
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/startApp\(\);\s*$/, '');
const ctx = vm.createContext({ console, AbortController, setTimeout: () => 1, clearTimeout() {},
  setInterval: () => 2, clearInterval() {},
  document: { getElementById: element, querySelectorAll: () => [] }, CSS: { escape: s => s },
  window: { addEventListener() {}, scrollTo() {}, location: { assign() {} } }, confirm: () => true,
  fetch: async (path, options) => path === '/api/sticker'
    ? Response.json({ discipline: JSON.parse(options.body).discipline, unlocked: true })
    : Response.json({ email: 'alice@example.com', data: {}, versions: {}, stickers: {} })
});
const run = s => vm.runInContext(s, ctx);
run(code); await run('loadState()'); assert.equal(run('cloudReady'), true);
run('openStickerAlbum()');
assert.doesNotMatch(element('appContainer').innerHTML, /<img/);
run("openStickerBiography('geografia')");
assert(!element('stickerBiographyDialog').open);
run("openDiscipline('historia')");
const historyPage = element('appContainer').innerHTML;
assert(historyPage.indexOf('music-launch-card') > historyPage.indexOf('onclick="openVideos('));
assert.match(historyPage, /Músicas para revisão de História/);
run('openMusic()');
assert.equal(element('headerTitle').textContent, 'Músicas de História');
assert.match(element('appContainer').innerHTML, /Ferro, Fumaça e Revolução/);
assert.match(element('appContainer').innerHTML, /<audio controls preload="metadata"/);
assert.match(element('appContainer').innerHTML, /src="\/audio\/ferro-fumaca-e-revolucao.mp3"/);
assert.match(element('appContainer').innerHTML, /src="\/audio\/da-bastilha-eu-grito.mp3"/);
assert.match(element('appContainer').innerHTML, /Ouça a música para revisar o Absolutismo\./);
assert.doesNotMatch(element('appContainer').innerHTML, /Revolução Francesa/);
assert.doesNotMatch(element('appContainer').innerHTML, /Marcas na Paisagem/);
run('goBack()');
assert.equal(run('currentView'), 'discipline');
assert.equal(run('selectedDisciplineId'), 'historia');
run("openDiscipline('geografia')");
const geographyPage = element('appContainer').innerHTML;
assert.match(geographyPage, /music-launch-card" onclick="openMusic\(\)">[\s\S]*?Músicas para revisão de Geografia/);
assert(geographyPage.indexOf('openVideos') < geographyPage.indexOf('openMusic'));
assert(geographyPage.indexOf('openMusic') < geographyPage.indexOf('openSpeedQuiz'));
run('openMusic()');
assert.equal(element('headerTitle').textContent, 'Músicas de Geografia');
assert.match(element('appContainer').innerHTML, /MUDANÇAS E IMPACTOS AMBIENTAIS<\/span>\s*<h2[^>]*>Marcas na Paisagem<\/h2>/);
assert.match(element('appContainer').innerHTML, /<audio controls preload="metadata"[^>]*src="\/audio\/marcas-na-paisagem.mp3"/);
assert.doesNotMatch(element('appContainer').innerHTML, /Da Bastilha eu grito/);
run('goBack()');
assert.equal(run('currentView'), 'discipline');
assert.equal(run('selectedDisciplineId'), 'geografia');
run("openDiscipline('filosofia')");
assert.match(element('appContainer').innerHTML, /music-launch-card" onclick="openMusic\(\)">[\s\S]*?Músicas para revisão de Filosofia/);
run('openMusic()');
assert.equal(element('headerTitle').textContent, 'Músicas de Filosofia');
assert.match(element('appContainer').innerHTML, /ARISTÓTELES E SUA FILOSOFIA<\/span>\s*<h2[^>]*>O caminho da virtude<\/h2>/);
assert.match(element('appContainer').innerHTML, /<audio controls preload="metadata"[^>]*src="\/audio\/o-caminho-da-virtude.mp3"/);
run('goBack()');
assert.equal(run('currentView'), 'discipline');
assert.equal(run('selectedDisciplineId'), 'filosofia');
run("openDiscipline('literatura')");
assert.match(element('appContainer').innerHTML, /music-launch-card" onclick="openMusic\(\)">[\s\S]*?Músicas para revisão de Literatura/);
run('openMusic()');
assert.equal(element('headerTitle').textContent, 'Músicas de Literatura');
assert.match(element('appContainer').innerHTML, /O Modernismo chegou junto com a liberdade de criar<\/h2>/);
assert.match(element('appContainer').innerHTML, /src="\/audio\/o-modernismo-chegou-junto-com-a-liberdade-de-criar.mp3"/);
run('goBack()');
run("openDiscipline('historia')");
assert(historyPage.indexOf("onclick=\"openSpeedQuiz('historia')\"") > historyPage.indexOf('onclick="openMusic()"'));
run('openSpeedQuiz()');
assert.match(element('appContainer').innerHTML, /dois minutos e trinta segundos/);
assert.match(element('appContainer').innerHTML, /Começar quiz/);
assert.equal(run('speedQuestionBank().length'), 20);
assert.equal(run('HISTORY_SPEED_QUESTIONS.map(q => q.answer).join(\'\')'), 'CADBDBACBDCADBACBDCA');
run('startSpeedQuiz()');
assert.equal(run('speedRound.questions.length'), 10);
assert.equal(run('new Set(speedRound.questions.map(q => q.id)).size'), 10);
assert.match(element('appContainer').innerHTML, /2:30/);
run('speedRound.deadline = Date.now() + 61000; tickSpeedQuiz()');
assert.equal(run('speedRound.finished'), false);
assert.equal(element('speedQuizClock').textContent, '1:01');
const firstRoundIds = run('speedRound.questions.map(q => q.id)');
run("for (let i = 0; i < 9; i++) answerSpeedQuiz(i, speedRound.questions[i].answer)");
assert.equal(run('speedRound.finished'), false);
run("answerSpeedQuiz(9, speedRound.questions[9].answer)");
assert.equal(run('speedRound.finished'), false);
assert.equal(element('finishSpeedQuizButton').disabled, false);
run("answerSpeedQuiz(9, speedRound.questions[9].answer === 'A' ? 'B' : 'A')");
assert.equal(run('speedRound.finished'), false);
run('answerSpeedQuiz(9, speedRound.questions[9].answer); finishSpeedQuiz(false)');
assert.match(element('appContainer').innerHTML, /Parabéns você acertou todas. Está no caminho certo para o ENEM 2027!/);
run('startSpeedQuiz()');
assert(run('speedRound.questions.map(q => q.id)').every(id => !firstRoundIds.includes(id)));
run("answerSpeedQuiz(0, speedRound.questions[0].answer); answerSpeedQuiz(0, speedRound.questions[0].answer === 'A' ? 'B' : 'A'); answerSpeedQuiz(1, speedRound.questions[1].answer)");
assert.equal(run('Object.keys(speedRound.answers).length'), 2);
run('speedRound.deadline = Date.now() - 1; tickSpeedQuiz()');
assert.match(element('appContainer').innerHTML, /Você acertou 1 de 10 questões/);
assert.match(element('appContainer').innerHTML, /O tempo acabou/);
const lockedAnswer = run('speedRound.answers[0]');
run("answerSpeedQuiz(0, speedRound.questions[0].answer)");
assert.equal(run('speedRound.answers[0]'), lockedAnswer);
run("startSpeedQuiz(); speedRound.deadline = Date.now() - 1; answerSpeedQuiz(0, 'A')");
assert.equal(run('Object.keys(speedRound.answers).length'), 0);
assert.equal(run('speedRound.expired'), true);
run('startSpeedQuiz(); goBack()');
assert.equal(run('currentView'), 'discipline');
assert.equal(run('speedTimer'), null);
assert.equal(run('speedRound'), null);
run("openDiscipline('geografia')");
assert.match(element('appContainer').innerHTML, /openSpeedQuiz\('geografia'\)/);
assert(element('appContainer').innerHTML.indexOf('openSpeedQuiz') > element('appContainer').innerHTML.indexOf('openVideos'));
run("openSpeedQuiz('geografia')");
assert.equal(run('selectedDisciplineId'), 'geografia');
assert.match(element('appContainer').innerHTML, /Quiz de Geografia/);
assert.equal(run('speedQuestionBank().length'), 20);
assert.equal(run("speedQuestionBank().map(q => q.answer).join('')"), 'BDACBDCACDABACBDDBAC');
run('startSpeedQuiz()');
assert.equal(run('speedRound.questions.length'), 10);
assert(run('speedRound.questions.every(q => q.id.startsWith("geografia-"))'));
assert.match(element('appContainer').innerHTML, /2:30/);
const geographyIds = run('speedRound.questions.map(q => q.id)');
run('for (let i = 0; i < 10; i++) answerSpeedQuiz(i, speedRound.questions[i].answer)');
assert.equal(run('speedRound.finished'), false);
run('finishSpeedQuiz(false)');
assert.match(element('appContainer').innerHTML, /Parabéns/);
await run('speedRound.stickerSavePromise');
assert.equal(run('earnedStickers.geografia'), true);
run('startSpeedQuiz()');
assert(run('speedRound.questions.map(q => q.id)').every(id => !geographyIds.includes(id)));
run('speedRound.deadline = Date.now() - 1; tickSpeedQuiz()');
assert.equal(run('speedRound.expired'), true);
run('goBack()');
assert.equal(run('selectedDisciplineId'), 'geografia');
assert.equal(run('currentView'), 'discipline');
assert.equal(run('speedTimer'), null);
run('openSpeedQuiz()');
assert.equal(run('selectedDisciplineId'), 'historia');
assert(run('speedQuestionBank().every(q => q.id.startsWith("historia-"))'));
run('goBack()');
assert.match(albumHtml, /border: 5px solid #FFFFFF/);
run('openStickerAlbum()');
assert.match(element('appContainer').innerHTML, /src="\/figurinhas\/milton-santos.jpg"/);
run("openStickerBiography('geografia')");
assert.equal(element('stickerBiographyTitle').textContent, 'Milton Santos (1926–2001)');
assert.match(element('stickerBiographyBody').innerHTML, /Milton Santos foi um geógrafo brasileiro/);
assert.equal((element('stickerBiographyBody').innerHTML.match(/<p>/g) || []).length, 2);
run('closeStickerBiography()');
assert.equal(element('stickerBiographyDialog').open, false);
// Erros, tempo esgotado, falha ao salvar, nova tentativa e recarga da conta.
run('earnedStickers = {}');
run("openSpeedQuiz('geografia'); startSpeedQuiz(); for (let i = 0; i < 10; i++) answerSpeedQuiz(i, 'X')");
assert.equal(run('Object.keys(speedRound.answers).length'), 0);
run("for (let i = 0; i < 10; i++) answerSpeedQuiz(i, speedRound.questions[i].answer === 'A' ? 'B' : 'A')");
assert.equal(run('earnedStickers.geografia'), undefined);
run('startSpeedQuiz(); speedRound.deadline = Date.now() - 1; tickSpeedQuiz()');
assert.equal(run('earnedStickers.geografia'), undefined);
ctx.fetch = async () => { throw new TypeError('Offline'); };
run('startSpeedQuiz(); for (let i = 0; i < 10; i++) answerSpeedQuiz(i, speedRound.questions[i].answer)');
run('finishSpeedQuiz(false)');
await run('speedRound.stickerSavePromise');
assert.equal(run('earnedStickers.geografia'), undefined);
assert.match(element('appContainer').innerHTML, /Salvar figurinha novamente/);
ctx.fetch = async () => Response.json({ discipline: 'geografia', unlocked: true });
run('retryQuizSticker()');
await run('speedRound.stickerSavePromise');
assert.equal(run('earnedStickers.geografia'), true);
ctx.fetch = async () => Response.json({ email: 'alice@example.com', data: {}, versions: {}, stickers: { geografia: true } });
run('earnedStickers = {}');
await run('loadState()');
run('openStickerAlbum()');
assert.match(element('appContainer').innerHTML, /src="\/figurinhas\/milton-santos.jpg"/);
assert.doesNotMatch(element('appContainer').innerHTML, /src="\/figurinhas\/zumbi-dos-palmares.jpg"/);
// Confere os limites do cronômetro com relógio controlado nas duas disciplinas.
const realDate = run('Date');
let quizNow = 1000000;
ctx.Date = class extends realDate { static now() { return quizNow; } };
for (const discipline of ['historia', 'geografia']) {
  run(`openSpeedQuiz('${discipline}'); startSpeedQuiz(); finishSpeedQuiz(false)`);
  assert.equal(run('speedRound.finished'), false);
  const startedAt = quizNow;
  for (const elapsed of [0, 30000, 60000, 90000, 120000, 149000, 149999]) {
    quizNow = startedAt + elapsed;
    run('tickSpeedQuiz()');
    assert.equal(run('speedRound.finished'), false, discipline + ' não encerra antes de 150 segundos');
  }
  assert.equal(element('speedQuizClock').textContent, '0:01');
  quizNow = startedAt + 150000;
  run('tickSpeedQuiz()');
  assert.equal(run('speedRound.finished'), true);
  assert.equal(run('speedRound.expired'), true);
  assert.equal(run('speedTimer'), null);
}
// Dez acertos aguardando o fim do prazo também conquistam a figurinha.
ctx.fetch = async () => Response.json({ discipline: 'geografia', unlocked: true });
run("earnedStickers = {}; openSpeedQuiz('geografia'); startSpeedQuiz(); for (let i = 0; i < 10; i++) answerSpeedQuiz(i, speedRound.questions[i].answer)");
quizNow += 150200;
run('tickSpeedQuiz()');
await run('speedRound.stickerSavePromise');
assert.equal(run('earnedStickers.geografia'), true);
assert.equal(run('speedRound.elapsedMs'), 150000);
ctx.Date = realDate;
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
