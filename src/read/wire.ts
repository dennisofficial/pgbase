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

type DecimalLike = { toFixed(): string };

export class PgbaseWireCodec extends SuperJSON {
  constructor(options: WireCodecOptions = {}) {
    super();
    this.registerDecimal(options.decimalConstructor);
    this.registerSerializers(options.serializers ?? []);
  }

  private registerDecimal(construct: WireCodecOptions['decimalConstructor']): void {
    this.registerCustom(
      {
        isApplicable: PgbaseWireCodec.isDecimalLike,
        serialize: (value) => value.toFixed(),
        deserialize: (value: string) => (construct?.(value) ?? value) as DecimalLike,
      },
      'pgbase.Decimal',
    );
  }

  private registerSerializers(serializers: readonly WireCustomType[]): void {
    for (const t of serializers) {
      this.registerCustom(
        { isApplicable: t.isApplicable, serialize: t.serialize, deserialize: t.deserialize },
        t.name,
      );
    }
  }

  private static isDecimalLike(value: unknown): value is DecimalLike {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
      typeof v.toFixed === 'function' &&
      typeof v.s === 'number' &&
      typeof v.e === 'number' &&
      Array.isArray(v.d)
    );
  }
}
