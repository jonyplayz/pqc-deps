import type { Env } from '../../../../server/env';
import { GitHub } from '../../../../server/github';
import { adminDecide } from '../../../../server/handlers';
import { handle } from '../../../../server/http';

export const onRequestPost: PagesFunction<Env> = ({ request, env, params }) =>
  handle(() => adminDecide({ request, env, gh: () => GitHub.fromEnv(env) }, Number(params.number)));
