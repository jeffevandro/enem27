const vm = require('node:vm');
const { studyTerms } = require('./tira-duvidas-termos.mjs');

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×', divide: '÷', deg: '°', sup2: '²', sup3: '³' };
const plainText = html => html.replace(/<[^>]+>/g, ' ')
  .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (entity, name) => {
    if (name[0] !== '#') return entities[name] ?? entity;
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  }).replace(/\s+/g, ' ').trim();

function addBrazilHistory(text, add, filename) {
  let theme = '';
  let subtheme = '';
  let topic = '';
  let count = 0;
  for (const block of text.trim().split(/\r?\n(?:[ \t]*\r?\n)+/)) {
    const paragraph = block.replace(/\s+/g, ' ').trim();
    const heading = /^(TEMA|SUBTEMA|TÓPICO)(?:\s+\d+(?:\.\d+)*)?\.\s+(.+)$/u.exec(paragraph);
    if (heading) {
      const [, level, title] = heading;
      if (level === 'TEMA') {
        theme = title.split(':')[0];
        subtheme = '';
        topic = '';
      } else if (level === 'SUBTEMA') {
        subtheme = title;
        topic = '';
      } else {
        topic = title;
      }
      continue;
    }
    if (paragraph === 'História do Brasil') continue;
    if (!theme || !subtheme) throw new Error('Parágrafo fora de um subtema em ' + filename + '.');
    const title = 'História do Brasil — ' + subtheme;
    const context = [theme, topic].filter(Boolean).join(' · ');
    const target = { reading: subtheme, filename };
    let remaining = paragraph;
    while (remaining.length > 750) {
      const limit = Math.min(750, remaining.length - 100);
      const sentences = [...remaining.slice(0, limit + 1).matchAll(/[.!?](?= )/g)];
      const sentenceEnd = (sentences.at(-1)?.index ?? -1) + 1;
      const wordEnd = remaining.lastIndexOf(' ', limit);
      const split = sentenceEnd >= limit / 2 ? sentenceEnd : wordEnd > 0 ? wordEnd : limit;
      if (add('historia', title, context, remaining.slice(0, split), target)) count++;
      remaining = remaining.slice(split).trimStart();
    }
    if (add('historia', title, context, remaining, target)) count++;
  }
  if (!count) throw new Error('Nenhum trecho aproveitável em ' + filename + '.');
}

function buildStudyIndex(html, curriculum, brazilHistory, brazilHistoryComplement) {
  const summaries = vm.runInNewContext('(' + html.match(/const SUMMARIES = (\{[\s\S]*?\});\s*function openSummary/)[1] + ')');
  const exams = vm.runInNewContext('(' + html.match(/const EXAM_PAGES = (\{[\s\S]*?\n\});/)[1] + ')');
  const flashcards = vm.runInNewContext(
    [...html.matchAll(/^const (?:[A-Z_]+_)?FLASHCARDS = [\s\S]*?^[\]}];/gm)].map(match => match[0]).join('\n') +
    '\n({ ...FLASHCARDS, brazil: BRAZIL_HISTORY_FLASHCARDS });'
  );
  const passages = [];
  const postings = Object.create(null);
  const template = id => {
    const match = html.match(new RegExp('<template id="' + id + '">([\\s\\S]*?)</template>'));
    if (!match) throw new Error('Material de estudo ausente: ' + id);
    return match[1];
  };
  function add(discipline, title, heading, text, target) {
    if (text.length < 35 || text.length > 750) return;
    const index = passages.push({ discipline, title, heading, text, target }) - 1;
    const terms = new Map([...studyTerms(text)].map(term => [term, 1]));
    for (const term of studyTerms(heading)) terms.set(term, (terms.get(term) ?? 0) + 3);
    for (const term of studyTerms(title)) terms.set(term, (terms.get(term) ?? 0) + 5);
    for (const [term, weight] of terms) (postings[term] ??= []).push(index, weight);
    return true;
  }
  for (const [key, summary] of Object.entries(summaries)) {
    const [discipline] = key.split('|');
    const title = summary.title.replace(/^RESUMO:\s*/i, '');
    for (const [group, sections] of summary.groups ?? [[null, summary.sections]]) {
      for (const [heading, items] of sections) {
        const label = heading.replace(/^\d+\.\s*/, '').replace(/:$/, '');
        for (const text of items) add(discipline, title, [group, label].filter(Boolean).join(' · '), text, { summary: key });
      }
    }
  }
  for (const [discipline, exam] of Object.entries(exams)) {
    const name = curriculum.find(item => item.id === discipline).name;
    for (const match of template(exam.template).matchAll(/<section>\s*<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]*?<div id="([a-z-]+-answer-\d+)" hidden>([\s\S]*?)<\/div>\s*<\/section>/g)) {
      for (const paragraph of match[3].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
        const text = plainText(paragraph[1]);
        if (!/^ALTERNATIVA CORRETA\b/i.test(text)) {
          add(discipline, `Questão ${plainText(match[1])} · ${name}`, '', text, { exam: match[2] });
        }
      }
    }
  }
  for (const [deck, cards] of Object.entries(flashcards)) {
    const discipline = deck === 'brazil' ? 'historia' : deck;
    const view = deck === 'brazil' ? 'brazilFlashcards' : 'flashcards';
    cards.forEach(([topic, question, answer], index) => {
      add(discipline, `Flashcard · ${topic}`, question, answer, { flashcard: index, view });
    });
  }
  for (const [, label, definition] of template('history-glossary-content')
    .matchAll(/<p><strong>([^<]+)<\/strong>:\s*([^<]+)<\/p>/g)) {
    const term = plainText(label);
    add('historia', term, 'Definição', plainText(definition), { glossary: term });
  }
  for (const [id, view, title] of [
    ['essay-guide-content', 'essayGuide', 'Cartilha de redação do ENEM'],
    ['essay-topics-content', 'essayTopics', 'Possíveis temas de redação do ENEM 2027']
  ]) {
    let heading = '';
    for (const [, element, content] of template(id).matchAll(/<(h2|p|li)[^>]*>([\s\S]*?)<\/\1>/g)) {
      if (element === 'h2') heading = plainText(content).replace(/^\d+\.\s*/, '');
      else add('redacao', title, heading, plainText(content), { essay: view });
    }
  }
  if (!passages.length) throw new Error('O índice do Tira-dúvidas está vazio.');
  addBrazilHistory(brazilHistory, add, 'historia-do-brasil.txt');
  if (brazilHistoryComplement !== undefined) {
    addBrazilHistory(brazilHistoryComplement, add, 'historia-do-brasil-complemento.txt');
  }
  return { disciplines: curriculum.map(discipline => discipline.id), passages, postings };
}

module.exports = { buildStudyIndex };
