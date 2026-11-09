import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/test/**/*.test.ts',
      'pipeline/**/test/**/*.test.ts',
      'site/test/**/*.test.ts',
    ],
  },
});
