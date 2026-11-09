import type { Env } from '../../server/env';
import { config } from '../../server/handlers';

export const onRequestGet: PagesFunction<Env> = ({ env }) => config(env);
