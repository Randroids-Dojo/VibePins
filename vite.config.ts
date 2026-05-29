import { defineConfig } from 'vitest/config';

// VibePins build config. The Rapier `-compat` build inlines its WASM, so no
// extra plugin or asset handling is needed for the physics engine.
export default defineConfig({
  server: {
    host: '0.0.0.0',
  },
  test: {
    // Pure-logic suites (config invariants, scoring) run under Node.
    // Add an environment override per-file when a suite touches the DOM.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
