export function daysSince(isoDate: string, now = new Date()): number {
  return Math.floor((now.getTime() - new Date(`${isoDate}T00:00:00Z`).getTime()) / 86_400_000);
}

/** Every n-th item starting at index k: spreads a daily run over n days. */
export function sliceOf<T>(items: T[], slice?: { k: number; n: number }): T[] {
  return slice ? items.filter((_, i) => i % slice.n === slice.k) : items;
}
