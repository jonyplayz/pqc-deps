/**
 * Ecosystem-agnostic version helpers. Deliberately forgiving: they handle
 * semver, PEP 440 (common cases), Go "v" prefixes, Maven ranges and qualifiers.
 * When in doubt they return undefined, and the checker reports "can't tell".
 */

interface Parsed {
  nums: number[];
  /** Pre-release / qualifier tag; empty for final releases. */
  pre: string;
}

const RELEASE_QUALIFIERS = /^(final|ga|release|r)$/i;

function parse(v: string): Parsed | undefined {
  const s = v
    .trim()
    .replace(/^[v=]+/i, '')
    .replace(/\+.*$/, '');
  const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(s);
  if (!m) return undefined;
  const nums = m[1]!.split('.').map(Number);
  let pre = m[2]!.replace(/^[-._]/, '');
  if (RELEASE_QUALIFIERS.test(pre)) pre = '';
  // "1.2.x" / "1.2.*" are wildcards, not pre-releases.
  if (/^[x*]/i.test(pre)) pre = '';
  return { nums, pre };
}

/** -1 / 0 / 1, or undefined if either side isn't a recognisable version. */
export function compareVersions(a: string, b: string): number | undefined {
  const A = parse(a);
  const B = parse(b);
  if (!A || !B) return undefined;
  const len = Math.max(A.nums.length, B.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (A.nums[i] ?? 0) - (B.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1; // 1.0 > 1.0-rc1
  if (!B.pre) return -1;
  return A.pre < B.pre ? -1 : 1;
}

export function isVersion(v: string): boolean {
  return parse(v) !== undefined;
}

/**
 * The lowest version a requirement allows, e.g. "^1.2.3" → "1.2.3",
 * ">=42,<45" → "42", "[1.0,2.0)" → "1.0", "~=2.8" → "2.8", "1.2.x" → "1.2".
 * Undefined when there's no lower bound ("*", "<2", "latest").
 */
export function lowerBound(spec: string): string | undefined {
  const s = spec.trim();
  if (!s || s === '*' || /^(latest|x)$/i.test(s)) return undefined;

  // npm "a || b": the lowest of the alternatives.
  if (s.includes('||')) {
    const bounds = s.split('||').map((p) => lowerBound(p));
    if (bounds.some((b) => b === undefined)) return undefined;
    return (bounds as string[]).sort((a, b) => compareVersions(a, b) ?? 0)[0];
  }

  // Maven / NuGet ranges: [1.0,2.0) (1.0,] [1.0]
  const range = /^[[(]\s*([^,\])]*)\s*(?:,|[\])])/.exec(s);
  if (range) return range[1] && isVersion(range[1]) ? range[1].trim() : undefined;

  // npm hyphen range "1.2.3 - 2.0.0"
  const hyphen = /^(\S+)\s+-\s+\S+$/.exec(s);
  if (hyphen) return isVersion(hyphen[1]!) ? hyphen[1]!.replace(/^v/, '') : undefined;

  let best: string | undefined;
  for (const clause of s.split(/\s*,\s*|\s+(?=[<>=!~^])/).filter(Boolean)) {
    const m = /^(===|==|>=|>|~=|\^|~>|~|=)?\s*v?([\w.*+-]+)$/.exec(clause);
    if (!m) continue;
    const op = m[1] ?? '';
    const v = m[2]!.replace(/\.[x*](\.[x*])*$/i, '');
    if (!isVersion(v)) continue;
    if (['', '=', '==', '===', '>=', '>', '~=', '^', '~', '~>'].includes(op)) {
      if (!best || (compareVersions(v, best) ?? 0) > 0) best = v;
    }
  }
  return best;
}
