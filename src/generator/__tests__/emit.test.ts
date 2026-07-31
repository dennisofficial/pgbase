import { describe, expect, it } from 'vitest';
import type { StaticSchema } from '../../schema/types.js';
import { SCHEMA_FORMAT_VERSION } from '../../version.js';
import { emitStaticSchemaModule } from '../emit.js';

const SCHEMA: StaticSchema = {
  formatVersion: SCHEMA_FORMAT_VERSION,
  models: [
    {
      model: 'Job',
      table: 'jobs',
      namespace: 'public',
      fields: [
        {
          name: 'createdAt',
          column: 'created_at',
          type: 'DateTime',
          nativeType: ['Timestamptz', ['6']],
          enumName: null,
          isList: false,
          isRequired: true,
          isId: false,
          isUnique: false,
          isUpdatedAt: false,
          isForeignKey: false,
        },
      ],
      relations: [],
      primaryKey: ['id'],
      uniques: [],
    },
  ],
  enums: [],
};

describe('emitStaticSchemaModule', () => {
  const source = emitStaticSchemaModule(SCHEMA, { packageSpecifier: '@dltech/pgbase/schema' });

  it('imports StaticSchema type-only from the given package specifier', () => {
    expect(source).toContain("import type { StaticSchema } from '@dltech/pgbase/schema';");
  });

  it('default-exports a value checked against StaticSchema via "satisfies"', () => {
    expect(source).toMatch(/export default \{[\s\S]*\} satisfies StaticSchema;/);
  });

  it('emits data only — no declared type/interface, no other imports', () => {
    expect(source).not.toMatch(/\binterface\b/);
    expect(source).not.toMatch(/\btype\s+\w+\s*=/);
    expect(source.match(/^import.*$/gm)).toEqual([
      "import type { StaticSchema } from '@dltech/pgbase/schema';",
    ]);
  });

  it('never emits import.meta, __dirname, or an extensionless relative import', () => {
    expect(source).not.toContain('import.meta');
    expect(source).not.toContain('__dirname');
    expect(source).not.toMatch(/from ['"]\.\.?\//);
  });

  it('carries the actual field data through, including the map round-trip', () => {
    expect(source).toContain('"created_at"');
    expect(source).toContain('"Timestamptz"');
  });
});
