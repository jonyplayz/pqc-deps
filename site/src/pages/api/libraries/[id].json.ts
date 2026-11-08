import type { APIRoute } from 'astro';
import type { Library } from '@pqc-deps/core';
import { getLibraries } from '../../../lib/catalog';
import { toPublic } from '../../../lib/public';

export function getStaticPaths() {
  return getLibraries().map((library) => ({ params: { id: library.id }, props: { library } }));
}

export const GET: APIRoute = ({ props }) =>
  new Response(JSON.stringify(toPublic((props as { library: Library }).library)), {
    headers: { 'Content-Type': 'application/json' },
  });
