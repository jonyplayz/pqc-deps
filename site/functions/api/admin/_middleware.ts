// Every /api/admin/* request must carry a valid Cloudflare Access login.
import { requireAdmin } from '../../../server/access';
import type { Env } from '../../../server/env';
import { handle } from '../../../server/http';

export const onRequest: PagesFunction<Env, string, { email: string }> = (ctx) =>
  handle(async () => {
    ctx.data.email = await requireAdmin(ctx.request, ctx.env);
    return ctx.next();
  });
