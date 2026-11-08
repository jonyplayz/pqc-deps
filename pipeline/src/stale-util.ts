export function daysSince(isoDate: string, now = new Date()): number {
  return Math.floor((now.getTime() - new Date(`${isoDate}T00:00:00Z`).getTime()) / 86_400_000);
}
