import type { Env } from '../../../../server/env';
import { GitHub } from '../../../../server/github';
import { adminRequests } from '../../../../server/handlers';
import { handle } from '../../../../server/http';

export const onRequestGet: PagesFunction<Env> = ({ request, env }) =>
  handle(() => adminRequests({ request, env, gh: () => GitHub.fromEnv(env) }));
