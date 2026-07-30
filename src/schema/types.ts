export interface StaticSchema {
  readonly formatVersion: number;
  readonly models: readonly StaticModel[];
  readonly enums: readonly SchemaEnum[];
}

export interface StaticModel {
  readonly model: string;
  readonly table: string;
  readonly namespace: string;
  readonly fields: readonly StaticField[];
  readonly relations: readonly StaticRelation[];

  readonly primaryKey: readonly string[];
  readonly uniques: readonly (readonly string[])[];
}

export interface StaticField {
  readonly name: string;
  readonly column: string;
  readonly type: string;
  readonly nativeType: readonly [string, readonly string[]] | null;
  readonly enumName: string | null;
  readonly isList: boolean;
  readonly isRequired: boolean;
  readonly isId: boolean;
  readonly isUnique: boolean;
  readonly isUpdatedAt: boolean;
  readonly isForeignKey: boolean;
}

export interface StaticRelation {
  readonly name: string;
  readonly relationName: string;
  readonly targetModel: string;
  readonly cardinality: 'one' | 'many';
  readonly fromColumns: readonly string[];
  readonly toColumns: readonly string[];
  readonly isImplicitManyToMany: boolean;
}

export interface SchemaEnum {
  readonly name: string;
  readonly dbName: string;
  readonly values: readonly string[];
}

export interface ResolvedSchema {
  readonly formatVersion: number;
  readonly publication: string;
  readonly models: readonly ResolvedModel[];
  readonly enums: readonly SchemaEnum[];
  readonly byModel: ReadonlyMap<string, ResolvedModel>;
  readonly byTable: ReadonlyMap<string, ResolvedModel>;
}

export interface ResolvedModel extends Omit<StaticModel, 'fields' | 'relations'> {
  readonly fields: readonly ResolvedField[];
  readonly relations: readonly ResolvedRelation[];
  readonly byColumn: ReadonlyMap<string, ResolvedField>;
  readonly replicaIdentity: ReplicaIdentity;
  readonly publicationColumns: readonly string[] | null;
}

export interface ResolvedField extends StaticField {
  readonly typeOid: number;
  readonly typeName: string;
  readonly elementTypeOid: number | null;
  readonly elementTypeName: string | null;
  readonly isCitext: boolean;
  readonly enumValues: readonly string[] | null;
}

export interface ResolvedRelation extends StaticRelation {
  readonly joinTable: JoinTable | null;
}

export interface JoinTable {
  readonly namespace: string;
  readonly table: string;
  readonly columnA: string;
  readonly columnB: string;
  readonly modelA: string;
  readonly modelB: string;
}

/** `pg_class.relreplident`, decoded. */
export type ReplicaIdentity = 'default' | 'nothing' | 'full' | 'index';

export interface SchemaProvider {
  resolve(): Promise<ResolvedSchema>;
}
