import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    // A slot of its own, so this never fights a running dev server for the app's slot and silently
    // falls back to standby — which is indistinguishable from "no deltas ever arrive". It has to be
    // set here rather than in a `beforeAll`: `ConfigModule.forRoot()` reads and validates the
    // environment while `app.module.ts` is being imported, which ESM does before any hook runs.
    env: { PGBASE_SLOT: 'pgbase_e2e' },
    // One Nest app per file, each taking the replication slot in turn — they cannot overlap.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 90_000,
  },
  plugins: [
    // esbuild, vitest's default transform, does not implement `emitDecoratorMetadata` at all. Nest
    // reads `design:paramtypes` at runtime to resolve constructor injection, so without SWC every
    // injected dependency arrives as undefined and the module fails to boot.
    swc.vite({ module: { type: 'es6' } }),
  ],
});
