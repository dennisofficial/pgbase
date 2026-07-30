import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DATABASE_URL = 'postgresql://pgbase:pgbase@localhost:55433/pgbase_test';

export default async function setup(): Promise<void> {
  const apiDir = fileURLToPath(new URL('../examples/api', import.meta.url));
  const prismaBin = fileURLToPath(
    new URL('../examples/api/node_modules/.bin/prisma', import.meta.url),
  );

  execFileSync(prismaBin, ['migrate', 'deploy'], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'inherit',
  });
}
