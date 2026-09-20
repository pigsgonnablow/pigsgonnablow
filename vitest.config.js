import { defineConfig } from 'vitest/config';

// Only tests/unit and tests/sql run under vitest. tests/functions/*.test.ts are Deno tests (they use the
// Deno global) and run via `npm run test:fn`.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js', 'tests/sql/**/*.test.js'],
  },
});
