// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  // Change when a custom domain is bought.
  site: 'https://pqc-deps.pages.dev',
  trailingSlash: 'ignore',
  integrations: [preact(), sitemap()],
});
