// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  // Change when a custom domain is bought.
  site: 'https://pqc-deps.pages.dev',
  // Emit /libraries/openssl.html (not .../openssl/index.html): Cloudflare Pages
  // serves it at /libraries/openssl with no trailing-slash redirect, which
  // matches every internal link and canonical URL.
  trailingSlash: 'never',
  build: { format: 'file' },
  integrations: [preact(), sitemap({ filter: (page) => !page.includes('/admin') })],
});
