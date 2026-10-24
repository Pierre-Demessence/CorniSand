import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/bench.gpu.ts'],
    // The default reporter hides the output of passing tests, and the table is the result.
    reporters: ['verbose'],
    // Each speed runs 80 frames of a 3.4M-cell grid.
    testTimeout: 600_000,
  },
});
