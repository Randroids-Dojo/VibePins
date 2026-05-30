import { defineConfig } from 'vitest/config';

// VibePins build config. The Rapier `-compat` build inlines its WASM, so no
// extra plugin or asset handling is needed for the physics engine.
export default defineConfig({
  server: {
    host: '0.0.0.0',
  },
  build: {
    // The Rapier `-compat` chunk inlines the physics WASM, so it is irreducibly
    // large (~2.2MB) and is not splittable app code. Raise the chunk-size warning
    // ceiling above it so the warning fires only on genuinely oversized chunks,
    // not on a vendor whose size is intrinsic. App and renderer chunks stay well
    // under this (F-003).
    chunkSizeWarningLimit: 2400,
    rolldownOptions: {
      output: {
        // Split the two heavy vendors out of the app entry (F-003). The whole
        // bundle was one ~2.8MB chunk dominated by the renderer and the inlined
        // physics WASM, so any app-code change busted the cache for the entire
        // payload. Rapier carries the inlined WASM, so it is by far the largest
        // piece and earns its own long-lived chunk; Three.js is the renderer and
        // gets a second. The remaining app code (gameplay, scoring, UI shell)
        // lands in the entry chunk, which now re-downloads on a code change
        // without dragging the vendors with it. Splitting here, not via dynamic
        // import, keeps the boot path synchronous (main.ts pulls world3d/ball/
        // pins eagerly) so there is no extra load waterfall or async boot.
        codeSplitting: {
          groups: [
            { name: 'rapier', test: /node_modules[\\/]@dimforge[\\/]rapier3d-compat/ },
            { name: 'three', test: /node_modules[\\/]three[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    // Pure-logic suites (config invariants, scoring) run under Node.
    // Add an environment override per-file when a suite touches the DOM.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
