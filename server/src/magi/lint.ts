export function lint(background: string, phrases: string[]) {
  return phrases.filter(phrase => background.includes(phrase)).map(phrase => ({ field: 'background', phrase }));
}
