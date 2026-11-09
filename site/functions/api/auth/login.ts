import { startLogin } from '../../../server/auth';
import type { Env } from '../../../server/env';
import { handle } from '../../../server/http';

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(async () => startLogin(request, env));
