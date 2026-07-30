import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // pgbase is a git submodule inside the atlas monorepo, which has its own root pnpm-lock.yaml.
  // Without this, Next infers the workspace root from the nearest lockfile it finds walking up
  // and picks atlas's, not this one.
  outputFileTracingRoot: path.join(__dirname, '../..'),
};

export default nextConfig;
