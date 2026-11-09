/**
 * Input for adding a library, from the CLI, a workflow_dispatch (env vars) or a
 * GitHub issue form. Everything here is untrusted: it is validated strictly and
 * never interpolated into shell commands.
 */
import { z } from 'zod';
import {
  ALGORITHMS,
  ECOSYSTEM_LABEL,
  ECOSYSTEMS,
  REGISTRIES,
  type Ecosystem,
  type Registry,
} from '@pqc-deps/core';

const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => u.startsWith('https://'), 'must start with https://');

/** Allowed characters per registry (npm scopes, Maven group:artifact, Go paths…). */
const PACKAGE_NAME: Record<Registry, RegExp> = {
  npm: /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i,
  pypi: /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/,
  cargo: /^[A-Za-z0-9_-]+$/,
  go: /^[a-z0-9.-]+\.[a-z]{2,}(\/[A-Za-z0-9._~-]+)+$/,
  maven: /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/,
  nuget: /^[A-Za-z0-9._-]+$/,
};

export const NewLibraryInputSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'lowercase letters, digits and dashes')
    .max(60)
    .optional(),
  name: z.string().trim().min(2).max(80),
  ecosystem: z.enum(ECOSYSTEMS),
  repo: httpsUrl,
  homepage: httpsUrl.optional(),
  description: z.string().trim().max(300).optional(),
  package_names: z.partialRecord(z.enum(REGISTRIES), z.array(z.string()).min(1)).default({}),
  applicable_algorithms: z.array(z.enum(ALGORITHMS)).optional(),
  delegates_to: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)).default([]),
  watch_urls: z.array(httpsUrl).max(10).default([]),
});
export type NewLibraryInput = z.infer<typeof NewLibraryInputSchema>;

/** "OpenSSL 3" → "openssl-3", "Bouncy Castle (Java)" → "bouncy-castle-java". */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/**
 * Parse package specs like "npm:jose", "pypi: cryptography",
 * "maven:org.bouncycastle:bcprov-jdk18on", one per line or comma/space separated.
 */
export function parsePackageSpecs(text: string): {
  packages: Partial<Record<Registry, string[]>>;
  errors: string[];
} {
  const packages: Partial<Record<Registry, string[]>> = {};
  const errors: string[] = [];
  const tokens = text
    .replace(/(\w)\s*:\s+/g, '$1:') // "npm: jose" → "npm:jose"
    .split(/[\s,]+/)
    .map((t) => t.replace(/^`|`$/g, '').trim())
    .filter(Boolean);
  for (const t of tokens) {
    const i = t.indexOf(':');
    const reg = (i > 0 ? t.slice(0, i).toLowerCase() : '') as Registry;
    const name = i > 0 ? t.slice(i + 1) : '';
    if (!REGISTRIES.includes(reg)) {
      errors.push(`"${t}": start with a registry (${REGISTRIES.join(', ')}), e.g. npm:jose`);
      continue;
    }
    if (!PACKAGE_NAME[reg].test(name)) {
      errors.push(`"${t}": not a valid ${reg} package name`);
      continue;
    }
    const list = (packages[reg] ??= []);
    if (!list.includes(name)) list.push(name);
  }
  return { packages, errors };
}

const splitList = (s: string | undefined) =>
  (s ?? '')
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Accepts "go", "Go", or a label like "Java / JVM". */
export function parseEcosystem(value: string): Ecosystem | undefined {
  const v = value.trim().toLowerCase();
  const byId = ECOSYSTEMS.find((e) => e === v);
  if (byId) return byId;
  return ECOSYSTEMS.find((e) => ECOSYSTEM_LABEL[e].toLowerCase() === v);
}

export type RawInput = Partial<
  Record<
    | 'id'
    | 'name'
    | 'ecosystem'
    | 'repo'
    | 'homepage'
    | 'description'
    | 'packages'
    | 'applicable'
    | 'delegates'
    | 'watch_urls',
    string
  >
>;

/** Validate loose string fields into a NewLibraryInput, collecting readable errors. */
export function normalizeInput(raw: RawInput): { input?: NewLibraryInput; errors: string[] } {
  const errors: string[] = [];
  const blank = (s?: string) =>
    s && s.trim() && s.trim() !== '_No response_' ? s.trim() : undefined;

  const ecosystem = blank(raw.ecosystem) ? parseEcosystem(raw.ecosystem!) : undefined;
  if (!ecosystem) errors.push(`ecosystem: choose one of ${ECOSYSTEMS.join(', ')}`);
  const { packages, errors: pkgErrors } = parsePackageSpecs(blank(raw.packages) ?? '');
  errors.push(...pkgErrors.map((e) => `packages: ${e}`));

  const candidate = {
    ...(blank(raw.id) ? { id: blank(raw.id) } : {}),
    name: blank(raw.name) ?? '',
    ecosystem,
    repo: blank(raw.repo) ?? '',
    ...(blank(raw.homepage) ? { homepage: blank(raw.homepage) } : {}),
    ...(blank(raw.description) ? { description: blank(raw.description) } : {}),
    package_names: packages,
    ...(blank(raw.applicable) ? { applicable_algorithms: splitList(raw.applicable) } : {}),
    delegates_to: splitList(blank(raw.delegates)),
    watch_urls: splitList(blank(raw.watch_urls)),
  };
  const parsed = NewLibraryInputSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      if (i.path[0] === 'ecosystem' && !ecosystem) continue; // already reported
      errors.push(`${i.path.join('.') || 'input'}: ${i.message}`);
    }
  }
  return errors.length || !parsed.success ? { errors } : { input: parsed.data, errors: [] };
}

/** Read inputs passed by a workflow as ADD_* environment variables. */
export function rawInputFromEnv(env: NodeJS.ProcessEnv): RawInput {
  return {
    id: env.ADD_ID,
    name: env.ADD_NAME,
    ecosystem: env.ADD_ECOSYSTEM,
    repo: env.ADD_REPO,
    homepage: env.ADD_HOMEPAGE,
    description: env.ADD_DESCRIPTION,
    packages: env.ADD_PACKAGES,
    applicable: env.ADD_APPLICABLE,
    delegates: env.ADD_DELEGATES,
    watch_urls: env.ADD_WATCH_URLS,
  };
}

/** Split a GitHub issue-form body ("### Label\n\nvalue") into label → value. */
export function parseIssueForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = body
    .replace(/\r\n/g, '\n')
    .split(/^### +/m)
    .slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const label = (nl === -1 ? part : part.slice(0, nl)).trim();
    const value = nl === -1 ? '' : part.slice(nl + 1).trim();
    out[label] = value === '_No response_' ? '' : value;
  }
  return out;
}

/** Labels used in .github/ISSUE_TEMPLATE/new-library.yml. */
export const ISSUE_FIELDS: Record<keyof RawInput, string> = {
  id: 'Catalog id',
  name: 'Library name',
  ecosystem: 'Ecosystem',
  repo: 'Source repository URL',
  homepage: 'Homepage',
  description: 'Short description',
  packages: 'Package names',
  applicable: 'Applicable algorithms',
  delegates: 'Delegates crypto to',
  watch_urls: 'Pages to watch for evidence',
};

export function rawInputFromIssue(body: string): RawInput {
  const fields = parseIssueForm(body);
  const raw: RawInput = {};
  for (const [key, label] of Object.entries(ISSUE_FIELDS) as Array<[keyof RawInput, string]>) {
    if (fields[label] !== undefined) raw[key] = fields[label];
  }
  return raw;
}
