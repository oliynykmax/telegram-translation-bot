const UKRAINIAN_SPECIFIC = /[іїєґІЇЄҐ]/;
const CYRILLIC = /[Ѐ-ӿ]/g;
const LATIN = /[a-zA-Z]/g;
const ALPHA = /[a-zA-Zа-яА-ЯіїєґІЇЄҐ]/g;

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

export function isUkrainian(text: string): boolean {
  if (UKRAINIAN_SPECIFIC.test(text)) return true;
  const alpha = count(text, ALPHA);
  return alpha > 0 && count(text, CYRILLIC) / alpha > 0.5;
}

export function isEnglish(text: string): boolean {
  const latin = count(text, LATIN);
  const total = latin + count(text, CYRILLIC);
  return total > 0 && latin / total > 0.8;
}
