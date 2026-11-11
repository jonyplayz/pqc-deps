// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';

/** Third parties the pages may load from: Turnstile (bot check) and Web Analytics. */
const TURNSTILE = 'https://challenges.cloudflare.com';
const ANALYTICS_SCRIPT = 'https://static.cloudflareinsights.com';
const ANALYTICS_BEACON = 'https://cloudflareinsights.com';

export default defineConfig({
  // Change when a custom domain is bought.
  site: 'https://pqc-deps.pages.dev',
  // Emit /libraries/openssl.html (not .../openssl/index.html): Cloudflare Pages
  // serves it at /libraries/openssl with no trailing-slash redirect, which
  // matches every internal link and canonical URL.
  trailingSlash: 'never',
  build: { format: 'file' },
  integrations: [preact(), sitemap({ filter: (page) => !page.includes('/admin') })],
  // Content Security Policy: Astro hashes every script and style it emits, so no
  // inline code runs unless it's ours. Directives a <meta> tag can't carry
  // (frame-ancestors) are sent as HTTP headers from site/public/_headers.
  security: {
    csp: {
      algorithm: 'SHA-256',
      directives: [
        "default-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        `connect-src 'self' ${ANALYTICS_BEACON}`,
        `frame-src ${TURNSTILE}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ],
      scriptDirective: { resources: ["'self'", TURNSTILE, ANALYTICS_SCRIPT] },
    },
  },
});
