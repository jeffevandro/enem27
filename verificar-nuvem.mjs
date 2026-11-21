import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.mjs';
import { SPEED_BANKS } from './generated/app.mjs';

// Executa SQL real em SQLite e valida a autenticação com assinaturas RSA reais.
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const DB = {
  prepare(sql) {
    return {
      async run() { return db.prepare(sql).run(); },
      bind(...params) {
        return {
          async first() { return db.prepare(sql).get(...params) || null; },
          all() { return { results: db.prepare(sql).all(...params) }; }
        };
      }
    };
  },
  async batch(statements) {
    db.exec('BEGIN');
    try {
      const results = statements.map(statement => statement.all());
      db.exec('COMMIT');
      return results;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
};
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
assert.equal((await request('/api/tira-duvidas', alice, { question: 'O que foi a Revolução Francesa?' }, {}, 'POST')).status, 404);
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
for (const name of ['max-weber', 'aristoteles', 'magda-soares', 'albert-einstein', 'hipatia', 'marie-curie', 'charles-darwin', 'carolina-maria-jesus']) {
  const portraitPath = `/figurinhas/${name}.jpg`;
  const portraitBytes = fs.readFileSync(new URL('./public' + portraitPath, import.meta.url));
  assert.equal(portraitBytes.readUInt16BE(0), 0xffd8);
  assert.equal((await request(portraitPath)).status, 401);
  env.ASSETS = { async fetch(req) {
    assert.equal(new URL(req.url).pathname, portraitPath);
    return new Response(req.method === 'HEAD' ? null : portraitBytes, { headers: { 'Content-Type': 'image/jpeg' } });
  } };
  const portraitResponse = await request(portraitPath, alice);
  assert.equal(portraitResponse.status, 200);
  assert.equal(portraitResponse.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await portraitResponse.arrayBuffer()), portraitBytes);
  assert.equal(await (await request(portraitPath, alice, undefined, {}, 'HEAD')).text(), '');
}
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
for (const discipline of ['historia', 'geografia', 'sociologia', 'filosofia', 'portugues', 'fisica', 'matematica', 'quimica', 'biologia', 'literatura']) {
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
assert.deepEqual(state.stickers, { historia: true, geografia: true, sociologia: true, filosofia: true, portugues: true, fisica: true, matematica: true, quimica: true, biologia: true, literatura: true });
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
const homeMarkup = element('appContainer').innerHTML;
assert.match(homeMarkup, /onclick="openCurrentAffairs\(\)"/);
assert.doesNotMatch(homeMarkup, /openStudyHelp|TIRE SUAS DÚVIDAS/i);
let disciplineCardCount = 0;
for (const { id, themes } of run('CURRICULUM')) {
  run(`openDiscipline('${id}')`);
  const page = element('appContainer').innerHTML;
  const cards = [...page.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.ok(cards.length >= themes.length, id);
  for (const [, attributes, card] of cards) {
    assert.match(attributes, /class="discipline-card(?: discipline-card-primary)?"/, id);
    const lines = [...card.matchAll(/<span class="discipline-card-(label|title|meta)">([^<]+)<\/span>/g)];
    assert.deepEqual(lines.map(([, role]) => role), ['label', 'title', 'meta'], `Três linhas no card de ${id}`);
    assert.ok(lines.every(([, , text]) => text.trim()), `Linhas preenchidas no card de ${id}`);
  }
  disciplineCardCount += cards.length;
}
console.log(`Cards verificados: ${disciplineCardCount} em ${run('CURRICULUM.length')} disciplinas, todos com três linhas.`);
run('goHome()');
const biographies = html.match(/<template id="history-people-content">([\s\S]*?)<\/template>/)[1];
const [generalBiographies, brazilianBiographies] = biographies.split('<h2>História do Brasil</h2>');
assert.match(generalBiographies, /<h2>História Geral<\/h2>/);
for (const group of [generalBiographies, brazilianBiographies]) {
  assert.equal(Array.from(group.matchAll(/<details id="personagem-/g)).length, 15);
}
element('history-people-content').content = { cloneNode: () => biographies };
element('appContainer').replaceChildren = function (content) { this.innerHTML = content; };
run("openDiscipline('historia')");
assert.match(element('appContainer').innerHTML, /onclick="openHistoryPeople\(\)"[\s\S]*?PERSONAGENS HISTÓRICOS/);
run('openHistoryPeople()');
assert.equal(element('headerTitle').textContent, 'Personagens históricos');
assert.equal(element('appContainer').innerHTML, biographies);
run('goBack()');
assert.equal(run('currentView'), 'discipline');
run('goHome()');
for (const [discipline, view] of [
  ['biologia', 'flashcards'], ['sociologia', 'flashcards'], ['filosofia', 'flashcards'],
  ['literatura', 'flashcards'], ['artes', 'flashcards'], ['tics', 'flashcards'], ['quimica', 'flashcards'],
  ['matematica', 'flashcards'], ['fisica', 'flashcards'], ['lingua_estrangeira', 'flashcards'],
  ['historia', 'flashcards'], ['historia', 'brazilFlashcards']
]) {
  run(`openDiscipline('${discipline}')`);
  const action = `openFlashcards('${view}')`;
  const card = element('appContainer').innerHTML.split('<button').find(button => button.includes(`onclick="${action}"`));
  assert.ok(card?.includes('20 cartões'));
  element('flashcardReveal').setAttribute = function (key, value) { this[key] = value; };
  run(action);
  if (discipline === 'lingua_estrangeira') {
    assert.ok(card.includes('REVISÃO COM FLASHCARDS - INGLÊS'));
    assert.equal(element('headerTitle').textContent, 'REVISÃO COM FLASHCARDS - INGLÊS');
  }
  if (discipline === 'historia') {
    const brazil = view === 'brazilFlashcards';
    const title = 'REVISÃO COM FLASHCARDS - HISTÓRIA ' + (brazil ? 'DO BRASIL' : 'GERAL');
    assert.ok(card.includes(title));
    assert.equal(element('headerTitle').textContent, title);
    assert.equal(element('flashcardTopic').textContent, brazil ? 'Povos indígenas antes de 1500' : 'Egito e Mesopotâmia');
  }
  const topics = new Set();
  for (let i = 1; i <= 20; i++) {
    assert.equal(element('flashcardPosition').textContent, `Cartão ${i} de 20`);
    assert.equal(element('flashcardAnswer').hidden, true);
    topics.add(element('flashcardTopic').textContent);
    run('setFlashcardAnswerVisible(true)');
    assert.equal(element('flashcardAnswer').hidden, false);
    assert.ok(element('flashcardAnswer').textContent.trim());
    run('changeFlashcard(1)');
  }
  assert.equal(topics.size, 20);
  assert.equal(element('flashcardPosition').textContent, 'Cartão 1 de 20');
  run('goBack()');
  assert.equal(run('selectedDisciplineId'), discipline);
}
run('openStickerAlbum()');
assert.doesNotMatch(element('appContainer').innerHTML, /<img/);
run("openStickerBiography('geografia')");
assert(!element('stickerBiographyDialog').open);
run("openDiscipline('historia')");
const historyPage = element('appContainer').innerHTML;
assert(historyPage.indexOf('onclick="openMusic()"') > historyPage.indexOf('onclick="openVideos('));
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
assert.match(geographyPage, /discipline-card" onclick="openMusic\(\)">[\s\S]*?Músicas para revisão de Geografia/);
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
assert.match(element('appContainer').innerHTML, /discipline-card" onclick="openMusic\(\)">[\s\S]*?Músicas para revisão de Filosofia/);
run('openMusic()');
assert.equal(element('headerTitle').textContent, 'Músicas de Filosofia');
assert.match(element('appContainer').innerHTML, /ARISTÓTELES E SUA FILOSOFIA<\/span>\s*<h2[^>]*>O caminho da virtude<\/h2>/);
assert.match(element('appContainer').innerHTML, /<audio controls preload="metadata"[^>]*src="\/audio\/o-caminho-da-virtude.mp3"/);
run('goBack()');
assert.equal(run('currentView'), 'discipline');
assert.equal(run('selectedDisciplineId'), 'filosofia');
run("openDiscipline('literatura')");
assert.match(element('appContainer').innerHTML, /discipline-card" onclick="openMusic\(\)">[\s\S]*?Músicas para revisão de Literatura/);
run('openMusic()');
assert.equal(element('headerTitle').textContent, 'Músicas de Literatura');
assert.match(element('appContainer').innerHTML, /O Modernismo chegou junto com a liberdade de criar<\/h2>/);
assert.match(element('appContainer').innerHTML, /src="\/audio\/o-modernismo-chegou-junto-com-a-liberdade-de-criar.mp3"/);
run("openDiscipline('portugues')");
assert.match(element('appContainer').innerHTML, /REVISÃO COM FLASHCARDS - LÍNGUA PORTUGUESA<\/span>\s*<span class="discipline-card-meta">20 cartões/);
run('openFlashcards()');
assert.equal(element('flashcardPosition').textContent, 'Cartão 1 de 20');
run('goBack()');
run('openMusic()');
assert.match(element('appContainer').innerHTML, /<audio controls[^>]*src="\/audio\/as-palavras-tem-poesia\.mp3"/);
assert.ok(fs.existsSync(new URL('./public/audio/as-palavras-tem-poesia.mp3', import.meta.url)));
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
run("openDiscipline('sociologia')");
const sociologyPage = element('appContainer').innerHTML;
assert.match(sociologyPage, /class="discipline-card" onclick="openSpeedQuiz\('sociologia'\)">\s*<span class="discipline-card-info">\s*<span class="discipline-card-label">Quiz de Sociologia<\/span>/);
assert.match(sociologyPage, /openQuiz\('sociologia'\)/);
run("openSpeedQuiz('sociologia')");
assert.match(element('appContainer').innerHTML, /Quiz de Sociologia/);
assert.equal(run('speedQuestionBank().length'), 24);
assert(run('speedQuestionBank().every(q => q.id.startsWith("sociologia-"))'));
run('startSpeedQuiz()');
const sociologyIds = run('speedRound.questions.map(q => q.id)');
assert.equal(new Set(sociologyIds).size, 10);
run('for (let i = 0; i < 10; i++) answerSpeedQuiz(i, speedRound.questions[i].answer)');
run('finishSpeedQuiz(false)');
await run('speedRound.stickerSavePromise');
assert.equal(run('earnedStickers.sociologia'), true);
run('startSpeedQuiz()');
assert(run('speedRound.questions.map(q => q.id)').every(id => !sociologyIds.includes(id)));
run('goBack()');
assert.equal(run('selectedDisciplineId'), 'sociologia');
run('openStickerAlbum()');
assert.match(element('appContainer').innerHTML, /src="\/figurinhas\/max-weber\.jpg"[^>]+alt="Figurinha de Max Weber"/);
assert.doesNotMatch(element('appContainer').innerHTML, /src="\/figurinhas\/aristoteles\.jpg"/);
run("openStickerBiography('sociologia')");
assert.equal(element('stickerBiographyTitle').textContent, 'Max Weber (1864–1920)');
run('closeStickerBiography()');
run("openDiscipline('filosofia')");
assert.match(element('appContainer').innerHTML, /class="discipline-card" onclick="openSpeedQuiz\('filosofia'\)">\s*<span class="discipline-card-info">\s*<span class="discipline-card-label">Quiz de Filosofia<\/span>/);
run("openSpeedQuiz('filosofia')");
assert.match(element('appContainer').innerHTML, /onclick="startSpeedQuiz\(\)">/);
const philosophyBank = run('speedQuestionBank()');
assert.equal(philosophyBank.length, 20);
assert(philosophyBank.every(q => q.id.startsWith('filosofia-')));
for (const letter of 'ABCD') assert.equal(philosophyBank.filter(q => q.answer === letter).length, 5);
run('startSpeedQuiz()');
assert.match(element('appContainer').innerHTML, /2:30/);
const philosophyIds = run('speedRound.questions.map(q => q.id)');
assert.equal(new Set(philosophyIds).size, 10);
run('for (let i = 0; i < 10; i++) answerSpeedQuiz(i, speedRound.questions[i].answer)');
run('finishSpeedQuiz(false)');
assert.match(element('appContainer').innerHTML, /Parabéns/);
await run('speedRound.stickerSavePromise');
assert.equal(run('earnedStickers.filosofia'), true);
assert.match(element('appContainer').innerHTML, /Figurinha conquistada!/);
run('startSpeedQuiz()');
assert.equal(new Set([...philosophyIds, ...run('speedRound.questions.map(q => q.id)')]).size, 20);
run('goBack()');
assert.equal(run('selectedDisciplineId'), 'filosofia');
assert.equal(run('currentView'), 'discipline');
assert.equal(run('speedTimer'), null);
run('openStickerAlbum()');
assert.match(element('appContainer').innerHTML, /src="\/figurinhas\/aristoteles\.jpg"[^>]+alt="Figurinha de Aristóteles"/);
run("openStickerBiography('filosofia')");
assert.equal(element('stickerBiographyTitle').textContent, 'Aristóteles (384–322 a.C.)');
assert.match(element('stickerBiographyBody').innerHTML, /Liceu em Atenas/);
run('closeStickerBiography()');
run("openDiscipline('portugues')");
assert.match(element('appContainer').innerHTML, /class="discipline-card" onclick="openSpeedQuiz\('portugues'\)">\s*<span class="discipline-card-info">\s*<span class="discipline-card-label">Quiz de Língua Portuguesa<\/span>/);
run("openSpeedQuiz('portugues')");
assert.match(element('appContainer').innerHTML, /Quiz de Língua Portuguesa/);
assert.equal(run("speedQuestionBank().map(q => q.answer).join('')"), 'BDACDACBADCBDABCADBC');
run('startSpeedQuiz()');
assert.match(element('appContainer').innerHTML, /2:30/);
const portugueseIds = run('speedRound.questions.map(q => q.id)');
assert.equal(new Set(portugueseIds).size, 10);
const firstPortugueseRound = element('appContainer').innerHTML;
run("for (let i = 0; i < 10; i++) answerSpeedQuiz(i, i === 0 ? (speedRound.questions[i].answer === 'A' ? 'B' : 'A') : speedRound.questions[i].answer)");
run('finishSpeedQuiz(false)');
assert.match(element('appContainer').innerHTML, /Você acertou 9 de 10 questões/);
assert.equal(run('earnedStickers.portugues'), undefined);
run('startSpeedQuiz()');
assert.equal(new Set([...portugueseIds, ...run('speedRound.questions.map(q => q.id)')]).size, 20);
assert.match(firstPortugueseRound + element('appContainer').innerHTML, /Leia o texto a seguir\.\n\n&quot;Cada vez mais jovens[\s\S]*?silenciosa\.&quot;\n\nA ideia central do texto é/);
run('for (let i = 0; i < 10; i++) answerSpeedQuiz(i, speedRound.questions[i].answer)');
run('finishSpeedQuiz(false)');
await run('speedRound.stickerSavePromise');
assert.equal(run('earnedStickers.portugues'), true);
assert.match(element('appContainer').innerHTML, /Figurinha conquistada!/);
run('goBack()');
assert.equal(run('selectedDisciplineId'), 'portugues');
assert.equal(run('currentView'), 'discipline');
assert.equal(run('speedTimer'), null);
run('openStickerAlbum()');
assert.match(element('appContainer').innerHTML, /src="\/figurinhas\/magda-soares\.jpg"[^>]+alt="Figurinha de Magda Soares"/);
run("openStickerBiography('portugues')");
assert.equal(element('stickerBiographyTitle').textContent, 'Magda Soares (1932–2023)');
assert.match(element('stickerBiographyBody').innerHTML, /projeto Alfaletrar/);
run('closeStickerBiography()');
assert.doesNotMatch(element('appContainer').innerHTML, /src="\/figurinhas\/albert-einstein\.jpg"/);
run("openDiscipline('fisica')");
assert.match(element('appContainer').innerHTML, /class="discipline-card" onclick="openSpeedQuiz\('fisica'\)">\s*<span class="discipline-card-info">\s*<span class="discipline-card-label">Quiz de Física<\/span>/);
run("openSpeedQuiz('fisica')");
const physicsBank = run('speedQuestionBank()');
assert.equal(physicsBank.map(q => q.answer).join(''), 'CBDABDACDBADCABCADBC');
assert.equal(physicsBank.filter(q => [q.question, ...Object.values(q.options)].some(text => text.includes(' = '))).length, 10);
run('startSpeedQuiz()');
assert.match(element('appContainer').innerHTML, /2:30/);
const firstPhysicsRound = element('appContainer').innerHTML;
const physicsIds = run('speedRound.questions.map(q => q.id)');
run('for (let i = 0; i < 10; i++) answerSpeedQuiz(i, speedRound.questions[i].answer)');
run('finishSpeedQuiz(false)');
assert.match(element('appContainer').innerHTML, /Parabéns/);
await run('speedRound.stickerSavePromise');
assert.equal(run('earnedStickers.fisica'), true);
assert.match(element('appContainer').innerHTML, /Figurinha conquistada!/);
run('startSpeedQuiz()');
assert.equal(new Set([...physicsIds, ...run('speedRound.questions.map(q => q.id)')]).size, 20);
assert.match(firstPhysicsRound + element('appContainer').innerHTML, /vₘ = d \/ Δt/);
assert.match(firstPhysicsRound + element('appContainer').innerHTML, /Fᵣ = m · ___/);
run('goBack()');
assert.equal(run('currentView'), 'discipline');
assert.equal(run('selectedDisciplineId'), 'fisica');
run('openStickerAlbum()');
assert.match(element('appContainer').innerHTML, /src="\/figurinhas\/albert-einstein\.jpg"[^>]+alt="Figurinha de Albert Einstein"/);
run("openStickerBiography('fisica')");
assert.equal(element('stickerBiographyTitle').textContent, 'Albert Einstein (1879–1955)');
assert.match(element('stickerBiographyBody').innerHTML, /efeito fotoelétrico/);
run('closeStickerBiography()');
assert.doesNotMatch(element('appContainer').innerHTML, /src="\/figurinhas\/hipatia\.jpg"/);
run("openDiscipline('matematica')");
assert.match(element('appContainer').innerHTML, /class="discipline-card" onclick="openSpeedQuiz\('matematica'\)">\s*<span class="discipline-card-info">\s*<span class="discipline-card-label">Quiz de Matemática<\/span>/);
run("openSpeedQuiz('matematica')");
const mathBank = run('speedQuestionBank()');
assert.equal(mathBank.map(q => q.answer).join(''), 'BDCABCDADBCABDACADCB');
assert.equal(mathBank.filter(q => [q.question, ...Object.values(q.options)].some(text => text.includes(' = '))).length, 10);
run('startSpeedQuiz()');
assert.match(element('appContainer').innerHTML, /2:30/);
const mathIds = run('speedRound.questions.map(q => q.id)');
assert.equal(new Set(mathIds).size, 10);
run('for (let i = 0; i < 10; i++) answerSpeedQuiz(i, speedRound.questions[i].answer)');
run('finishSpeedQuiz(false)');
assert.match(element('appContainer').innerHTML, /Parabéns/);
await run('speedRound.stickerSavePromise');
assert.equal(run('earnedStickers.matematica'), true);
assert.match(element('appContainer').innerHTML, /Figurinha conquistada!/);
run('startSpeedQuiz()');
assert.equal(new Set([...mathIds, ...run('speedRound.questions.map(q => q.id)')]).size, 20);
run('goBack()');
assert.equal(run('selectedDisciplineId'), 'matematica');
assert.equal(run('currentView'), 'discipline');
run('openStickerAlbum()');
assert.match(element('appContainer').innerHTML, /src="\/figurinhas\/hipatia\.jpg"[^>]+alt="Figurinha de Hipátia de Alexandria"/);
run("openStickerBiography('matematica')");
assert.equal(element('stickerBiographyTitle').textContent, 'Hipátia de Alexandria (séculos IV e V)');
assert.match(element('stickerBiographyBody').innerHTML, /seções cônicas/);
run('closeStickerBiography()');
assert.doesNotMatch(element('appContainer').innerHTML, /src="\/figurinhas\/marie-curie\.jpg"/);
run("openDiscipline('quimica')");
assert.match(element('appContainer').innerHTML, /class="discipline-card" onclick="openSpeedQuiz\('quimica'\)">\s*<span class="discipline-card-info">\s*<span class="discipline-card-label">Quiz de Química<\/span>/);
run("openSpeedQuiz('quimica')");
assert.equal(run("speedQuestionBank().map(q => q.answer).join('')"), 'DBACBDCACBDABDCACDBA');
run('startSpeedQuiz()');
assert.match(element('appContainer').innerHTML, /2:30/);
const chemistryIds = run('speedRound.questions.map(q => q.id)');
assert.equal(new Set(chemistryIds).size, 10);
run('for (let i = 0; i < 10; i++) answerSpeedQuiz(i, speedRound.questions[i].answer)');
run('finishSpeedQuiz(false)');
assert.match(element('appContainer').innerHTML, /Parabéns/);
await run('speedRound.stickerSavePromise');
assert.equal(run('earnedStickers.quimica'), true);
assert.match(element('appContainer').innerHTML, /Figurinha conquistada!/);
run('startSpeedQuiz()');
assert.equal(new Set([...chemistryIds, ...run('speedRound.questions.map(q => q.id)')]).size, 20);
run('goBack()');
assert.equal(run('selectedDisciplineId'), 'quimica');
assert.equal(run('currentView'), 'discipline');
run('openStickerAlbum()');
assert.match(element('appContainer').innerHTML, /src="\/figurinhas\/marie-curie\.jpg"[^>]+alt="Figurinha de Marie Curie"/);
run("openStickerBiography('quimica')");
assert.equal(element('stickerBiographyTitle').textContent, 'Marie Curie (1867–1934)');
assert.match(element('stickerBiographyBody').innerHTML, /Nobel de Química/);
run('closeStickerBiography()');
assert.doesNotMatch(element('appContainer').innerHTML, /src="\/figurinhas\/charles-darwin\.jpg"/);
run("openDiscipline('biologia')");
assert.match(element('appContainer').innerHTML, /class="discipline-card" onclick="openSpeedQuiz\('biologia'\)">\s*<span class="discipline-card-info">\s*<span class="discipline-card-label">Quiz de Biologia<\/span>/);
run("openSpeedQuiz('biologia')");
assert.equal(run("speedQuestionBank().map(q => q.answer).join('')"), 'BDCADACBDBACBDACDBAC');
run('startSpeedQuiz()');
assert.match(element('appContainer').innerHTML, /2:30/);
const biologyIds = run('speedRound.questions.map(q => q.id)');
assert.equal(new Set(biologyIds).size, 10);
run('for (let i = 0; i < 10; i++) answerSpeedQuiz(i, speedRound.questions[i].answer)');
run('finishSpeedQuiz(false)');
assert.match(element('appContainer').innerHTML, /Parabéns/);
await run('speedRound.stickerSavePromise');
assert.equal(run('earnedStickers.biologia'), true);
assert.match(element('appContainer').innerHTML, /Figurinha conquistada!/);
run('startSpeedQuiz()');
assert.equal(new Set([...biologyIds, ...run('speedRound.questions.map(q => q.id)')]).size, 20);
run('goBack()');
assert.equal(run('selectedDisciplineId'), 'biologia');
assert.equal(run('currentView'), 'discipline');
run('openStickerAlbum()');
assert.match(element('appContainer').innerHTML, /src="\/figurinhas\/charles-darwin\.jpg"[^>]+alt="Figurinha de Charles Darwin"/);
run("openStickerBiography('biologia')");
assert.equal(element('stickerBiographyTitle').textContent, 'Charles Darwin (1809–1882)');
assert.match(element('stickerBiographyBody').innerHTML, /seleção natural/);
run('closeStickerBiography()');
assert.doesNotMatch(element('appContainer').innerHTML, /src="\/figurinhas\/carolina-maria-jesus\.jpg"/);
run("openDiscipline('literatura')");
assert.match(element('appContainer').innerHTML, /class="discipline-card" onclick="openSpeedQuiz\('literatura'\)">\s*<span class="discipline-card-info">\s*<span class="discipline-card-label">Quiz de Literatura<\/span>/);
run("openSpeedQuiz('literatura')");
assert.equal(run("speedQuestionBank().map(q => q.answer).join('')"), 'BDACBADCDBCABCDACDAB');
run('startSpeedQuiz()');
assert.match(element('appContainer').innerHTML, /2:30/);
const literatureIds = run('speedRound.questions.map(q => q.id)');
assert.equal(new Set(literatureIds).size, 10);
run('for (let i = 0; i < 10; i++) answerSpeedQuiz(i, speedRound.questions[i].answer)');
run('finishSpeedQuiz(false)');
assert.match(element('appContainer').innerHTML, /Parabéns/);
await run('speedRound.stickerSavePromise');
assert.equal(run('earnedStickers.literatura'), true);
assert.match(element('appContainer').innerHTML, /Figurinha conquistada!/);
run('startSpeedQuiz()');
assert.equal(new Set([...literatureIds, ...run('speedRound.questions.map(q => q.id)')]).size, 20);
run('goBack()');
assert.equal(run('selectedDisciplineId'), 'literatura');
assert.equal(run('currentView'), 'discipline');
run('openStickerAlbum()');
assert.match(element('appContainer').innerHTML, /src="\/figurinhas\/carolina-maria-jesus\.jpg"[^>]+alt="Figurinha de Carolina Maria de Jesus"/);
run("openStickerBiography('literatura')");
assert.equal(element('stickerBiographyTitle').textContent, 'Carolina Maria de Jesus (1914–1977)');
assert.match(element('stickerBiographyBody').innerHTML, /Quarto de despejo/);
run('closeStickerBiography()');
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
// Confere os limites do cronômetro com relógio controlado.
const realDate = run('Date');
let quizNow = 1000000;
ctx.Date = class extends realDate { static now() { return quizNow; } };
for (const discipline of ['historia', 'geografia', 'sociologia', 'filosofia', 'portugues', 'fisica', 'matematica', 'quimica', 'biologia', 'literatura']) {
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
