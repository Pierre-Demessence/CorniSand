import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/bench.gpu.ts', 'tests/proto-movement.bench.gpu.ts'],
    // The default reporter hides the output of passing tests, and the table is the result.
    reporters: ['verbose'],
    // Two scenes and the prototype's tables, each running 80 frames of a 3.4M-cell grid at four speeds.
    testTimeout: 600_000,
  },
});
