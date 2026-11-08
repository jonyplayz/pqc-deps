/** Parse + validate library YAML text. Browser-safe (no fs). */
import { parse as parseYaml } from 'yaml';
import { LibrarySchema, type Library } from './schema';

export interface LoadError {
  file: string;
  message: string;
}

export type LoadResult = { ok: true; library: Library } | { ok: false; errors: LoadError[] };

export function parseLibraryYaml(text: string, file: string): LoadResult {
  let raw: unknown;
  try {
    raw = parseYaml(text, { prettyErrors: true });
  } catch (e) {
    return { ok: false, errors: [{ file, message: `YAML syntax: ${(e as Error).message}` }] };
  }
  const parsed = LibrarySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        file,
        message: `${i.path.join('.') || '(root)'}: ${i.message}`,
      })),
    };
  }
  const expectedId = file
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/\.ya?ml$/, '');
  if (parsed.data.id !== expectedId) {
    return {
      ok: false,
      errors: [
        { file, message: `id "${parsed.data.id}" must match the file name "${expectedId}"` },
      ],
    };
  }
  return { ok: true, library: parsed.data };
}
