import type { Pool } from 'pg';
import { SCHEMA_FORMAT_VERSION } from '../version.js';
import { SchemaResolutionError } from './errors.js';
import type {
  JoinTable,
  ReplicaIdentity,
  ResolvedField,
  ResolvedModel,
  ResolvedRelation,
  ResolvedSchema,
  SchemaProvider,
  StaticModel,
  StaticSchema,
} from './types.js';

interface TableRow {
  readonly namespace: string;
  readonly table: string;
  readonly oid: number | null;
  readonly relreplident: string | null;
}

interface AttributeInfo {
  readonly attnum: number;
  readonly typeOid: number;
  readonly typeName: string;
  readonly elementTypeOid: number | null;
  readonly isCitext: boolean;
}

interface JoinTableGroup {
  readonly relationName: string;
  /** The two participating Prisma model names, in the order first observed. */
  readonly participants: readonly [string, string];
  readonly namespace: string;
  readonly table: string;
}

/** Table lookup key, `"namespace.table"` — how the WAL identifies a relation too. */
function tableKey(namespace: string, table: string): string {
  return `${namespace}.${table}`;
}

/** The publication pgbase decodes from, unless the consumer names another. */
export const DEFAULT_PUBLICATION = 'pgbase';

export interface PgCatalogSchemaProviderOptions {
  /**
   * Which publication to read column lists from.
   *
   * This has to be named rather than inferred. `pg_publication_rel` is keyed by
   * (table, publication), so a table belonging to two publications can carry two *different*
   * column lists, and picking one arbitrarily would silently mis-report `publicationColumns` —
   * which the boot check below relies on to stop a table becoming unwritable. pgbase decodes
   * from exactly one publication, so scoping to it is both correct and unambiguous.
   */
  readonly publication?: string;
}

/**
 * Resolves a `StaticSchema` against a live Postgres `pg_catalog`. This is the only file in the
 * package that knows a schema came from Prisma at all (`SchemaProvider` is the seam) —
 * everything here is otherwise plain `pg.Pool` + SQL.
 */
export class PgCatalogSchemaProvider implements SchemaProvider {
  private readonly publication: string;

  constructor(
    private readonly staticSchema: StaticSchema,
    private readonly pool: Pool,
    options: PgCatalogSchemaProviderOptions = {},
  ) {
    this.publication = options.publication ?? DEFAULT_PUBLICATION;
  }

  async resolve(): Promise<ResolvedSchema> {
    this.checkFormatVersion();

    const modelWanted = this.staticSchema.models.map((m) => ({
      namespace: m.namespace,
      table: m.table,
    }));

    const joinGroups = this.discoverImplicitManyToManyGroups();
    const joinWanted = joinGroups.map((g) => ({ namespace: g.namespace, table: g.table }));

    const allWanted = [...modelWanted, ...joinWanted];
    const tableRows = await this.fetchTables(allWanted);
    const tableByKey = new Map(tableRows.map((r) => [tableKey(r.namespace, r.table), r]));

    for (const model of this.staticSchema.models) {
      const row = tableByKey.get(tableKey(model.namespace, model.table));
      if (!row || row.oid === null) {
        throw new SchemaResolutionError(
          `Model "${model.model}": no table "${model.table}" found in schema "${model.namespace}". ` +
            `Run migrations, or check "@@map" if the model name and table name differ.`,
        );
      }
    }
    for (const group of joinGroups) {
      const row = tableByKey.get(tableKey(group.namespace, group.table));
      if (!row || row.oid === null) {
        throw new SchemaResolutionError(
          `Implicit many-to-many relation "${group.relationName}" between ` +
            `"${group.participants[0]}" and "${group.participants[1]}": expected join table ` +
            `"${group.table}" in schema "${group.namespace}" but it does not exist. Prisma ` +
            `creates this table automatically on migrate — check migrations ran.`,
        );
      }
    }

    const modelOids = this.staticSchema.models.map(
      (m) => tableByKey.get(tableKey(m.namespace, m.table))!.oid!,
    );
    const joinOids = joinGroups.map((g) => tableByKey.get(tableKey(g.namespace, g.table))!.oid!);
    const allOids = [...modelOids, ...joinOids];

    const attributesByOid = await this.fetchAttributes(allOids);
    const publicationColumnsByOid = await this.fetchPublicationColumns(allOids, attributesByOid);
    const joinTableByRelationName = await this.resolveJoinTables(
      joinGroups,
      tableByKey,
      attributesByOid,
    );

    const models: ResolvedModel[] = this.staticSchema.models.map((model) => {
      const row = tableByKey.get(tableKey(model.namespace, model.table))!;
      const oid = row.oid!;
      const attrs = attributesByOid.get(oid) ?? new Map<string, AttributeInfo>();

      const fields: ResolvedField[] = model.fields.map((field) => {
        const attr = attrs.get(field.column);
        if (!attr) {
          throw new SchemaResolutionError(
            `Model "${model.model}", field "${field.name}": no column "${field.column}" on ` +
              `table "${model.namespace}.${model.table}". Check "@map" and that migrations ran.`,
          );
        }
        return {
          ...field,
          typeOid: attr.typeOid,
          typeName: attr.typeName,
          elementTypeOid: attr.elementTypeOid,
          isCitext: attr.isCitext,
        };
      });

      if (model.primaryKey.length === 0) {
        throw new SchemaResolutionError(
          `Model "${model.model}" (table "${model.namespace}.${model.table}") has no primary ` +
            `key. §7.5 rejects no-PK tables — a row with no identity cannot be tracked across a ` +
            `WAL stream.`,
        );
      }

      const replicaIdentity = decodeReplicaIdentity(model, row.relreplident);
      const publicationColumns = publicationColumnsByOid.get(oid) ?? null;

      if (replicaIdentity === 'full' && publicationColumns !== null) {
        throw new SchemaResolutionError(
          `Model "${model.model}" (table "${model.namespace}.${model.table}") has ` +
            `REPLICA IDENTITY FULL and is also published with a restricted column list ` +
            `(${publicationColumns.join(', ')}). Postgres accepts this DDL combination but then ` +
            `blocks every UPDATE and DELETE on the table at DML time (§7.3) — the error would ` +
            `otherwise surface at the first write instead of at boot. Either drop the column ` +
            `list (publish all columns) or switch the table off REPLICA IDENTITY FULL.`,
        );
      }

      const relations: ResolvedRelation[] = model.relations.map((relation) => ({
        ...relation,
        joinTable: relation.isImplicitManyToMany
          ? (joinTableByRelationName.get(relation.relationName) ?? null)
          : null,
      }));

      const byColumn = new Map(fields.map((f) => [f.column, f]));

      return {
        ...model,
        fields,
        relations,
        byColumn,
        replicaIdentity,
        publicationColumns,
      };
    });

    const byModel = new Map(models.map((m) => [m.model, m]));
    const byTable = new Map(models.map((m) => [tableKey(m.namespace, m.table), m]));

    return {
      formatVersion: this.staticSchema.formatVersion,
      publication: this.publication,
      models,
      enums: this.staticSchema.enums,
      byModel,
      byTable,
    };
  }

  private checkFormatVersion(): void {
    if (this.staticSchema.formatVersion !== SCHEMA_FORMAT_VERSION) {
      throw new SchemaResolutionError(
        `StaticSchema is format v${this.staticSchema.formatVersion}, but this pgbase reads ` +
          `v${SCHEMA_FORMAT_VERSION}. Re-run "prisma generate" to refresh the generated schema.`,
      );
    }
  }

  private discoverImplicitManyToManyGroups(): readonly JoinTableGroup[] {
    const byRelationName = new Map<string, { model: string; targetModel: string }[]>();
    for (const model of this.staticSchema.models) {
      for (const relation of model.relations) {
        if (!relation.isImplicitManyToMany) continue;
        const list = byRelationName.get(relation.relationName) ?? [];
        list.push({ model: model.model, targetModel: relation.targetModel });
        byRelationName.set(relation.relationName, list);
      }
    }

    const groups: JoinTableGroup[] = [];
    for (const [relationName, entries] of byRelationName) {
      if (entries.length !== 2) {
        throw new SchemaResolutionError(
          `Implicit many-to-many relation "${relationName}" is declared on ` +
            `${entries.length} model field(s); expected exactly 2 (one on each side).`,
        );
      }
      const [a, b] = entries;
      const modelA = this.requireModel(a.model);
      // Both sides of an implicit m2m are, by construction, in the same schema Prisma put the
      // join table in, so the first participant's namespace is used here. The table name itself
      // (`_` + relation name) is only a guess used to locate that row in pg_catalog — never
      // parsed further. `resolveJoinTables` derives columnA/columnB/modelA/modelB from the
      // table's actual foreign keys instead.
      groups.push({
        relationName,
        participants: [a.model, b.model],
        namespace: modelA.namespace,
        table: `_${relationName}`,
      });
    }
    return groups;
  }

  private requireModel(name: string): StaticModel {
    const model = this.staticSchema.models.find((m) => m.model === name);
    if (!model) {
      throw new SchemaResolutionError(`Relation references unknown model "${name}".`);
    }
    return model;
  }

  private async fetchTables(
    wanted: readonly { namespace: string; table: string }[],
  ): Promise<TableRow[]> {
    if (wanted.length === 0) return [];
    const namespaces = wanted.map((w) => w.namespace);
    const tables = wanted.map((w) => w.table);
    const { rows } = await this.pool.query<{
      namespace: string;
      table: string;
      oid: number | null;
      relreplident: string | null;
    }>(
      `
      WITH wanted(namespace, tbl) AS (
        SELECT * FROM unnest($1::text[], $2::text[])
      )
      SELECT
        w.namespace,
        w.tbl AS table,
        c.oid::int AS oid,
        c.relreplident
      FROM wanted w
      LEFT JOIN pg_namespace n ON n.nspname = w.namespace
      LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = w.tbl
      `,
      [namespaces, tables],
    );
    return rows;
  }

  private async fetchAttributes(
    oids: readonly number[],
  ): Promise<Map<number, Map<string, AttributeInfo>>> {
    const result = new Map<number, Map<string, AttributeInfo>>();
    if (oids.length === 0) return result;

    const { rows } = await this.pool.query<{
      reloid: number;
      column: string;
      attnum: number;
      type_oid: number;
      type_name: string;
      element_type_oid: number | null;
      is_citext: boolean;
    }>(
      `
      SELECT
        a.attrelid::int AS reloid,
        a.attname AS column,
        a.attnum::int AS attnum,
        t.oid::int AS type_oid,
        t.typname AS type_name,
        CASE WHEN t.typcategory = 'A' AND t.typelem <> 0 THEN t.typelem::int ELSE NULL END AS element_type_oid,
        (t.typname = 'citext') AS is_citext
      FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = ANY($1::int[])
        AND a.attnum > 0
        AND NOT a.attisdropped
      `,
      [oids],
    );

    for (const row of rows) {
      const forTable = result.get(row.reloid) ?? new Map<string, AttributeInfo>();
      forTable.set(row.column, {
        attnum: row.attnum,
        typeOid: row.type_oid,
        typeName: row.type_name,
        elementTypeOid: row.element_type_oid,
        isCitext: row.is_citext,
      });
      result.set(row.reloid, forTable);
    }
    return result;
  }

  /**
   * Publication column lists, from PG15+'s `pg_publication_rel.prattrs`, scoped to
   * `this.publication`.
   *
   * Deliberately not a scan of every publication: `pg_publication_rel` is keyed by
   * (table, publication), so the same table can carry a different column list in each one, and
   * picking one arbitrarily would mis-report the value the boot check above depends on.
   *
   * A table absent from this publication, or present with unrestricted membership, resolves to
   * `null` — "not published" and "published, all columns" only need to be told apart from
   * "restricted to these columns", not from each other.
   *
   * A `FOR ALL TABLES` publication has no `pg_publication_rel` row for any table, so a plain
   * join alone would report every table as "not published" and the check above would never
   * fire — hence the separate `puballtables` branch below, unrestricted by definition.
   */
  private async fetchPublicationColumns(
    oids: readonly number[],
    attributesByOid: ReadonlyMap<number, ReadonlyMap<string, AttributeInfo>>,
  ): Promise<Map<number, readonly string[] | null>> {
    const result = new Map<number, readonly string[] | null>();
    if (oids.length === 0) return result;

    const { rows } = await this.pool.query<{ reloid: number; prattrs: string | null }>(
      `
      SELECT
        pr.prrelid::int AS reloid,
        pr.prattrs::text AS prattrs
      FROM pg_publication_rel pr
      JOIN pg_publication p ON p.oid = pr.prpubid
      WHERE pr.prrelid = ANY($1::int[])
        AND p.pubname = $2
      UNION ALL
      -- FOR ALL TABLES publications have no pg_publication_rel rows; membership is implicit and
      -- always unrestricted.
      SELECT c.oid::int AS reloid, NULL AS prattrs
      FROM pg_class c
      CROSS JOIN pg_publication p
      WHERE c.oid = ANY($1::int[])
        AND p.pubname = $2
        AND p.puballtables
      `,
      [oids, this.publication],
    );

    const unrestricted = new Set<number>();
    const restricted = new Map<number, string[]>();
    for (const row of rows) {
      if (row.prattrs === null) {
        unrestricted.add(row.reloid);
        continue;
      }
      if (restricted.has(row.reloid)) continue;
      const attnums = row.prattrs
        .trim()
        .split(/\s+/)
        .filter((s) => s.length > 0)
        .map(Number);
      const attrsByAttnum = new Map<number, string>();
      for (const [column, info] of attributesByOid.get(row.reloid) ?? []) {
        attrsByAttnum.set(info.attnum, column);
      }
      const columns = attnums.map((attnum) => {
        const column = attrsByAttnum.get(attnum);
        if (column === undefined) {
          throw new SchemaResolutionError(
            `Publication column list for table oid ${row.reloid} references attnum ${attnum}, ` +
              `which does not resolve to a known column.`,
          );
        }
        return column;
      });
      restricted.set(row.reloid, columns);
    }

    for (const oid of oids) {
      if (unrestricted.has(oid)) {
        result.set(oid, null);
      } else if (restricted.has(oid)) {
        result.set(oid, restricted.get(oid)!);
      } else {
        result.set(oid, null);
      }
    }
    return result;
  }

  /**
   * Resolves `columnA`/`columnB`/`modelA`/`modelB` for each discovered implicit m2m join table
   * from its actual foreign keys — never by parsing the table name further, which breaks on
   * model names that themselves contain the `To` separator Prisma uses to build that name.
   */
  private async resolveJoinTables(
    groups: readonly JoinTableGroup[],
    tableByKey: ReadonlyMap<string, TableRow>,
    attributesByOid: ReadonlyMap<number, ReadonlyMap<string, AttributeInfo>>,
  ): Promise<Map<string, JoinTable>> {
    const result = new Map<string, JoinTable>();
    if (groups.length === 0) return result;

    const modelByOid = new Map<number, StaticModel>();
    for (const model of this.staticSchema.models) {
      const row = tableByKey.get(tableKey(model.namespace, model.table));
      if (row?.oid !== null && row?.oid !== undefined) modelByOid.set(row.oid, model);
    }

    const joinOidByGroup = new Map(
      groups.map((g) => [g.relationName, tableByKey.get(tableKey(g.namespace, g.table))!.oid!]),
    );
    const joinOids = [...joinOidByGroup.values()];

    const { rows: fkRows } = await this.pool.query<{
      conrelid: number;
      conkey: number[];
      confrelid: number;
    }>(
      `
      SELECT
        con.conrelid::int AS conrelid,
        con.conkey AS conkey,
        con.confrelid::int AS confrelid
      FROM pg_constraint con
      WHERE con.contype = 'f' AND con.conrelid = ANY($1::int[])
      `,
      [joinOids],
    );
    const fksByOid = new Map<number, { conkey: number[]; confrelid: number }[]>();
    for (const row of fkRows) {
      const list = fksByOid.get(row.conrelid) ?? [];
      list.push({ conkey: row.conkey, confrelid: row.confrelid });
      fksByOid.set(row.conrelid, list);
    }

    for (const group of groups) {
      const joinOid = joinOidByGroup.get(group.relationName)!;
      const fks = fksByOid.get(joinOid) ?? [];
      if (fks.length !== 2) {
        throw new SchemaResolutionError(
          `Implicit many-to-many join table "${group.namespace}.${group.table}" (relation ` +
            `"${group.relationName}" between "${group.participants[0]}" and ` +
            `"${group.participants[1]}") has ${fks.length} foreign key constraint(s); expected ` +
            `exactly 2.`,
        );
      }

      const attrsByAttnum = new Map<number, string>();
      for (const [column, info] of attributesByOid.get(joinOid) ?? []) {
        attrsByAttnum.set(info.attnum, column);
      }

      const sides = fks.map((fk) => {
        if (fk.conkey.length !== 1) {
          throw new SchemaResolutionError(
            `Implicit many-to-many join table "${group.namespace}.${group.table}": a foreign ` +
              `key constraint spans ${fk.conkey.length} columns; expected exactly 1 per side.`,
          );
        }
        const column = attrsByAttnum.get(fk.conkey[0]!);
        const targetModel = modelByOid.get(fk.confrelid);
        if (!column || !targetModel) {
          throw new SchemaResolutionError(
            `Implicit many-to-many join table "${group.namespace}.${group.table}": could not ` +
              `resolve a foreign key's local column or target model from pg_catalog.`,
          );
        }
        return { column, targetModel: targetModel.model };
      });

      const [first, second] = sides as [(typeof sides)[0], (typeof sides)[0]];
      const [modelA, modelB] =
        first.targetModel <= second.targetModel ? [first, second] : [second, first];

      result.set(group.relationName, {
        namespace: group.namespace,
        table: group.table,
        columnA: modelA.column,
        columnB: modelB.column,
        modelA: modelA.targetModel,
        modelB: modelB.targetModel,
      });
    }

    return result;
  }
}

function decodeReplicaIdentity(model: StaticModel, raw: string | null): ReplicaIdentity {
  switch (raw) {
    case 'd':
      return 'default';
    case 'n':
      return 'nothing';
    case 'f':
      return 'full';
    case 'i':
      return 'index';
    default:
      throw new SchemaResolutionError(
        `Model "${model.model}" (table "${model.namespace}.${model.table}"): unrecognized ` +
          `pg_class.relreplident value ${JSON.stringify(raw)}.`,
      );
  }
}
