/** Static README badge per library: /badge/<id>.svg (rebuilt on every deploy). */
import type { APIRoute, GetStaticPaths } from 'astro';
import type { Library } from '@pqc-deps/core';
import { getLibraries } from '../../lib/catalog';
import { badgeSvg } from '../../lib/badge';

export const getStaticPaths: GetStaticPaths = () =>
  getLibraries().map((library) => ({ params: { id: library.id }, props: { library } }));

export const GET: APIRoute = ({ props }) => {
  const { library } = props as { library: Library };
  return new Response(badgeSvg(library.overall_status, library.name), {
    headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' },
  });
};
