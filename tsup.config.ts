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
  entry: [
    'src/index.ts',
    'src/nest/index.ts',
    'src/client/index.ts',
    'src/react/index.ts',
    'src/query/index.ts',
    'src/schema/index.ts',
    'src/policy/index.ts',
    'src/context/index.ts',
    'src/read/index.ts',
    'src/wal/index.ts',
    'src/live/index.ts',
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
