import { defineConfig } from 'prisma/config';

try {
  process.loadEnvFile();
} catch {}

export default defineConfig({
  schema: './prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
