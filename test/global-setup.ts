import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_DATABASE_URL = 'postgresql://pgbase:pgbase@localhost:55433/pgbase_test';

export default async function setup(): Promise<void> {
  const apiDir = fileURLToPath(new URL('../examples/api', import.meta.url));
  const prismaBin = fileURLToPath(
    new URL('../examples/api/node_modules/.bin/prisma', import.meta.url),
  );

  const binDir = fileURLToPath(new URL('../examples/api/node_modules/.bin', import.meta.url));

  const run = (args: string[]): void => {
    execFileSync(prismaBin, args, {
      cwd: apiDir,
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
      stdio: 'inherit',
    });
  };

  run(['migrate', 'deploy']);
  run(['generate']);
}
