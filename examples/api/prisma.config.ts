import { defineConfig } from 'prisma/config';

// Prisma 7 moved the datasource URL out of schema.prisma (P1012 if you leave `url = env(...)`
// there); it is supplied here instead. Verified against the installed `@prisma/config` types —
// `Datasource` is `{ url?: string; shadowDatabaseUrl?: string }`, so this is the whole shape.
export default defineConfig({
  // A FOLDER, not a file. Per the installed types: "path to the schema file, or path to a folder
  // that shall be recursively searched for *.prisma files." Without this, Prisma silently loads
  // only `prisma/schema.prisma` and every model under `prisma/models/` is ignored — `validate`
  // still passes, which is exactly how you ship an empty schema by accident.
  schema: './prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
