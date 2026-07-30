import { readFileSync } from 'fs';
import { join } from 'path';
import { defineConfig } from 'tsup';

// Read package.json to auto-detect externals
const packageJson = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));

const external = [
  ...Object.keys(packageJson.peerDependencies || {}),
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.devDependencies || {}).filter(
    (dep) => !dep.startsWith('@types/') && !['typescript', 'tsup'].includes(dep),
  ),
];

export default defineConfig({
  // One entry per public subpath. Keep in sync with package.json "exports". `generator/bin` is
  // not a subpath export — it is a CLI entry, resolved via package.json "bin" and spawned by
  // `prisma generate`, never `import`ed by a consumer.
  entry: [
    'src/index.ts',
    'src/nest/index.ts',
    'src/client/index.ts',
    'src/react/index.ts',
    'src/schema/index.ts',
    'src/generator/bin.ts',
  ],
  format: ['cjs', 'esm'],
  dts: false,
  splitting: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  external,
  treeshake: true,
  minify: false,
  target: 'es2023',
});
