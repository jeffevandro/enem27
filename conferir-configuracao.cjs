const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'wrangler.jsonc'), 'utf8'));
if (config.name !== 'revisao-enem27' || !config.keep_vars || config.preview_urls !== false) {
  throw new Error('Confira o nome do Worker, a preservação das variáveis e a desativação de previews.');
}
const database = config.d1_databases?.find(item => item.binding === 'DB');
if (!database || database.database_name !== 'enem27' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(database.database_id || '')) {
  throw new Error('Falta preencher em wrangler.jsonc o Database ID real do banco enem27 já existente. Nenhum banco novo deve ser criado.');
}
console.log('Configuração conferida: Worker revisao-enem27, variáveis preservadas e banco D1 existente.');
