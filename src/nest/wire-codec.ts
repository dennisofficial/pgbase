import { Inject, Injectable } from '@nestjs/common';
import { PgbaseWireCodec } from '../read/index.js';
import { PGBASE_OPTIONS } from './tokens.js';
import type { PgbaseModuleOptions } from './types.js';

@Injectable()
export class PgbaseWireCodecService extends PgbaseWireCodec {
  constructor(@Inject(PGBASE_OPTIONS) options: PgbaseModuleOptions) {
    super({
      serializers: options.serializers,
      decimalConstructor: options.decimalConstructor,
    });
  }
}
