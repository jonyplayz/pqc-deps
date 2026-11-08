/**
 * Public, static JSON export of the whole catalog. Also consumed by the
 * manifest checker and (later) the CLI / GitHub Action. Pipeline-only config
 * is stripped.
 */
import type { APIRoute } from 'astro';
import { getLibraries } from '../../lib/catalog';
import { toPublic } from '../../lib/public';

export const GET: APIRoute = () =>
  new Response(
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      license: 'CC-BY-4.0',
      libraries: getLibraries().map(toPublic),
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
