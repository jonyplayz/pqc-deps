import type { Env } from '../../../server/env';
import { json } from '../../../server/http';

export const onRequestGet: PagesFunction<Env, string, { login: string }> = ({ data }) =>
  json({ login: data.login });
