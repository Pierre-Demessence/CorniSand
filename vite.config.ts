import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  test: {
    include: ['tests/**/*.test.ts'],
    // Dawn pipeline compilation on a cold shader cache is slow.
    testTimeout: 60_000,
  },
});
