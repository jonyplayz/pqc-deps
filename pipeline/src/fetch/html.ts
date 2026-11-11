/** Minimal HTML → text conversion. Good enough to find and quote sentences. */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]!).replace(/\s+/g, ' ').trim() || undefined : undefined;
}

export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(
      /<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|table|pre|blockquote|dd|dt|header)>/gi,
      '\n',
    )
    .replace(/<(p|div|section|article|h[1-6]|tr|pre|blockquote|dd|dt)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ');
  // Strip remaining tags until nothing changes (nested fragments like "<<b>x>"
  // can re-form a tag after one pass), then drop stray angle brackets.
  for (let prev = ''; prev !== s;) {
    prev = s;
    s = s.replace(/<[^<>]*>/g, '');
  }
  s = s.replace(/[<>]/g, '');
  return decodeEntities(s)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l, i, arr) => l || (arr[i - 1] ?? '') !== '')
    .join('\n')
    .trim();
}
