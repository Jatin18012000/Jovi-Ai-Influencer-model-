/** Small, dependency-free text utilities shared by the memory retrievers. */

const STOPWORDS = new Set(
  (
    'a an and are as at be by for from has have her his i in is it its of on or our she that the their them they this to was ' +
    'were will with you your we us me my create make new about into over some any can who what when where how why which'
  ).split(' '),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

/** Very light stemming so "reels"/"reel" and "cafes"/"cafe" match. */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** Fraction of query tokens present in the document tokens (0..1). */
export function overlapScore(queryTokens: readonly string[], docTokens: Iterable<string>): number {
  if (queryTokens.length === 0) return 0;
  const doc = new Set(docTokens);
  let hits = 0;
  for (const t of new Set(queryTokens)) if (doc.has(t)) hits += 1;
  return hits / new Set(queryTokens).size;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function slugify(text: string, max = 60): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'item'
  );
}
