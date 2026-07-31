import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
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
