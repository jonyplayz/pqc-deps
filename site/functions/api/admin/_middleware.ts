// Every /api/admin/* request needs a signed-in maintainer (GitHub login).
import { requireAdmin } from '../../../server/auth';
import type { Env } from '../../../server/env';
import { handle } from '../../../server/http';

export const onRequest: PagesFunction<Env, string, { login: string }> = (ctx) =>
  handle(async () => {
    ctx.data.login = await requireAdmin(ctx.request, ctx.env);
    return ctx.next();
  });
