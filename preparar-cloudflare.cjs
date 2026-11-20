const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
process.chdir(__dirname);
const html = fs.readFileSync('index.html', 'utf8');
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const curriculum = JSON.parse(html.match(/const CURRICULUM = (.*);/)[1]);
const keys = [];
curriculum.forEach(d => d.themes.forEach((t, ti) => t.groups.forEach((g, gi) =>
  g.subthemes.forEach((_, si) => keys.push(`${d.id}|${ti}|${gi}|${si}`)))));
const banks = vm.runInNewContext(html.match(/const HISTORY_SPEED_QUESTIONS = ([\s\S]*?)let speedRound = null;/)[0].replace('let speedRound = null;', 'SPEED_QUESTION_BANKS;'));
const { buildStudyIndex } = require('./preparar-tira-duvidas.cjs');
const study = buildStudyIndex(html, curriculum);
const app = `const APP_HTML = ${JSON.stringify(html)};\nconst VALID_KEYS = ${JSON.stringify(keys)};\nconst SPEED_BANKS = ${JSON.stringify(banks)};\nconst STUDY = ${JSON.stringify(study)};\n`;
fs.mkdirSync('generated', { recursive: true });
fs.mkdirSync('cloudflare', { recursive: true });
fs.writeFileSync('generated/app.mjs', app + 'export { APP_HTML, VALID_KEYS, SPEED_BANKS, STUDY };\n');
const worker = fs.readFileSync('worker.mjs', 'utf8')
  .replace("import { APP_HTML, VALID_KEYS, SPEED_BANKS, STUDY } from './generated/app.mjs';", () => app)
  .replace("import { studyTerms } from './tira-duvidas-termos.mjs';", () =>
    fs.readFileSync('tira-duvidas-termos.mjs', 'utf8').replace('export function studyTerms', 'function studyTerms'));
fs.writeFileSync('cloudflare/worker-pronto.js', worker);
fs.writeFileSync('cloudflare/worker-pronto.txt', worker);
fs.copyFileSync('schema.sql', 'cloudflare/banco-de-dados.sql');
console.log(`Preparado: ${keys.length} subtemas e ${study.passages.length} trechos de estudo. Arquivos para o painel em ${path.resolve('cloudflare')}`);
