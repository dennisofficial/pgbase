import SuperJSON from 'superjson';

export type WireCodec = SuperJSON;

export type WireJson =
  string | number | boolean | undefined | null | WireJson[] | { [key: string]: WireJson };

export interface WireCustomType<T = unknown, S extends WireJson = WireJson> {
  readonly name: string;
  readonly isApplicable: (value: unknown) => value is T;
  readonly serialize: (value: T) => S;
  readonly deserialize: (value: S) => T;
}

export interface WireCodecOptions {
  readonly serializers?: readonly WireCustomType[];
  readonly decimalConstructor?: (value: string) => unknown;
}

function isDecimalLike(value: unknown): value is { toFixed(): string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.toFixed === 'function' &&
    typeof v.s === 'number' &&
    typeof v.e === 'number' &&
    Array.isArray(v.d)
  );
}

export function createWireCodec(options: WireCodecOptions = {}): WireCodec {
  const codec = new SuperJSON();

  codec.registerCustom(
    {
      isApplicable: isDecimalLike,
      serialize: (value) => value.toFixed(),
      deserialize: (value: string) =>
        (options.decimalConstructor?.(value) ?? value) as { toFixed(): string },
    },
    'pgbase.Decimal',
  );

  for (const t of options.serializers ?? []) {
    codec.registerCustom(
      { isApplicable: t.isApplicable, serialize: t.serialize, deserialize: t.deserialize },
      t.name,
    );
  }

  return codec;
}
