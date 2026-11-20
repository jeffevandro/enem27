const commonWords = new Set(`a ao aos as com como da das de dela dele do dos e ela ele em entre era essa esse esta este eu foi
  foram ha isso ja mais me mesmo meu minha muito na nas nao no nos o os ou para pela pelas pelo pelos pode por porque
  qual quais quando quanto que quem sao se sem ser seu sobre sua tem um uma uns voce enem resumo explique explica
  explicacao diferenca diferencas defina significado significa exemplo exemplos quero gostaria diga entender saber funciona
  importante principais principal estuda estudar ajuda`.split(/\s+/));

export function studyTerms(text) {
  const words = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter(word => (word.length >= 3 || word === 'ph') && /[a-z]/.test(word) && !commonWords.has(word))
    .map(word => word.length > 4 ? word.replace(/(oes|aes)$/, 'ao').replace(/([aeiou])s$/, '$1') : word));
}
