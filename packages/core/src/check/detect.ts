import type { ManifestFormat } from './types';

/** Guess the manifest format from the file name, falling back to the content. */
export function detectFormat(text: string, filename?: string): ManifestFormat | undefined {
  if (filename) {
    const base = filename.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
    if (base === 'package.json') return 'package.json';
    if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') return 'package-lock.json';
    if (/^requirements.*\.(txt|in)$/.test(base) || base === 'constraints.txt')
      return 'requirements.txt';
    if (base === 'pyproject.toml') return 'pyproject.toml';
    if (base === 'go.mod') return 'go.mod';
    if (base === 'pom.xml' || base.endsWith('.pom')) return 'pom.xml';
    if (base === 'build.gradle' || base === 'build.gradle.kts') return 'build.gradle';
    if (base.endsWith('.versions.toml')) return 'libs.versions.toml';
    if (base === 'cargo.toml') return 'Cargo.toml';
    if (base === 'cargo.lock') return 'Cargo.lock';
  }

  const t = text.trimStart();
  if (t.startsWith('{')) {
    if (/"lockfileVersion"\s*:/.test(t)) return 'package-lock.json';
    return 'package.json';
  }
  if (t.startsWith('<')) return /<project[\s>]/.test(t) ? 'pom.xml' : undefined;
  if (/^module\s+\S+/m.test(t)) return 'go.mod';
  if (/^\[\[package\]\]/m.test(t) && /^version\s*=\s*\d/m.test(t)) return 'Cargo.lock';
  if (/^\[libraries\]/m.test(t)) return 'libs.versions.toml';
  if (/^\[(project|tool\.poetry|build-system|dependency-groups)[\].]/m.test(t))
    return 'pyproject.toml';
  if (/^\[(package|dependencies|workspace)\]/m.test(t)) return 'Cargo.toml';
  if (
    /\b(implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\(?\s*["']/.test(t) ||
    /^\s*(plugins|dependencies)\s*\{/m.test(t)
  ) {
    return 'build.gradle';
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (
    lines.length &&
    lines.every((l) => /^\s*(-|[A-Za-z0-9][A-Za-z0-9._-]*\s*(\[|==|>=|<=|~=|!=|>|<|;|@|$))/.test(l))
  ) {
    return 'requirements.txt';
  }
  return undefined;
}
