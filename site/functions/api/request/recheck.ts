import type { Env } from '../../../server/env';
import { GitHub } from '../../../server/github';
import { requestRecheck } from '../../../server/handlers';
import { handle } from '../../../server/http';

export const onRequestPost: PagesFunction<Env> = ({ request, env }) =>
  handle(() => requestRecheck({ request, env, gh: () => GitHub.fromEnv(env) }));
