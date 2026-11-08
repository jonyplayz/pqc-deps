/** Resolve `delegates_to` chains into a tree, safe against cycles and dangling ids. */
import type { Library } from './schema';

export interface DelegationNode {
  library: Library;
  condition?: string;
  children: DelegationNode[];
}

export function delegationTree(
  lib: Library,
  byId: ReadonlyMap<string, Library>,
  seen: ReadonlySet<string> = new Set(),
): DelegationNode[] {
  const nextSeen = new Set(seen).add(lib.id);
  return lib.delegates_to.flatMap((d) => {
    const target = byId.get(d.id);
    if (!target || nextSeen.has(d.id)) return [];
    return [
      {
        library: target,
        ...(d.condition ? { condition: d.condition } : {}),
        children: delegationTree(target, byId, nextSeen),
      },
    ];
  });
}

/** Libraries that delegate to `id` (reverse edges). */
export function delegatedFrom(id: string, libs: readonly Library[]): Library[] {
  return libs.filter((l) => l.delegates_to.some((d) => d.id === id));
}
