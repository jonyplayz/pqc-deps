import type { Library } from '@pqc-deps/core';

/** The public API shape: everything except pipeline-only settings. */
export function toPublic(lib: Library): Omit<Library, 'pipeline'> {
  const { pipeline: _pipeline, ...rest } = lib;
  return rest;
}
