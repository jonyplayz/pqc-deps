import { parseDateOrTime } from '@pqc-deps/core';

export function daysSince(isoDate: string, now = new Date()): number {
  return Math.floor((now.getTime() - parseDateOrTime(isoDate).getTime()) / 86_400_000);
}

/** Every n-th item starting at index k: spreads a daily run over n days. */
export function sliceOf<T>(items: T[], slice?: { k: number; n: number }): T[] {
  return slice ? items.filter((_, i) => i % slice.n === slice.k) : items;
}

/** Set the top-level last_verified line of a library YAML file, touching nothing else. */
export function bumpLastVerified(yamlText: string, at: string): string {
  if (!/^last_verified:.*$/m.test(yamlText)) throw new Error('no top-level last_verified line');
  return yamlText.replace(/^last_verified:.*$/m, `last_verified: ${at}`);
}
