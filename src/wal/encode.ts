import { JSON_NULL, OID } from '../query/compare.js';
import type { ResolvedField } from '../schema/types.js';

export interface RowEncodeOptions {
  readonly decimalConstructor?: (value: string) => unknown;
}

function encodeScalar(typeOid: number, value: unknown, options: RowEncodeOptions): unknown {
  switch (typeOid) {
    case OID.TIMESTAMPTZ:
    case OID.TIMESTAMP:
      // decodeScalar floors to whole milliseconds, so this division is exact in both directions.
      return new Date(Number((value as bigint) / 1000n));
    case OID.DATE:
      return new Date(`${value as string}T00:00:00.000Z`);
    case OID.NUMERIC:
      return options.decimalConstructor?.(value as string) ?? value;
    case OID.JSON:
    case OID.JSONB:
      return value === JSON_NULL ? null : value;
    default:
      return value;
  }
}

export function encodeColumn(
  field: ResolvedField,
  value: unknown,
  options: RowEncodeOptions = {},
): unknown {
  if (value === null || value === undefined) return value;
  if (field.enumValues !== null || field.isCitext) return value;
  if (field.elementTypeOid !== null) {
    return (value as readonly unknown[]).map((el) =>
      el === null ? null : encodeScalar(field.elementTypeOid!, el, options),
    );
  }
  return encodeScalar(field.typeOid, value, options);
}
