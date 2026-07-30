import { Body, Controller, HttpCode, Inject, Post, type Type } from '@nestjs/common';
import {
  DEFAULT_ARGS_TREE_LIMITS,
  ReadValidationError,
  checkArgsTreeBounds,
  type ArgsTreeLimits,
  type ReadArgs,
  type WireCodec,
} from '../read/index.js';
import { PgbaseReadService } from './read-service.js';
import { PGBASE_OPTIONS, PGBASE_WIRE_CODEC } from './tokens.js';
import type { PgbaseModuleOptions } from './types.js';

const KNOWN_ARG_KEYS = new Set([
  'where',
  'select',
  'include',
  'orderBy',
  'take',
  'skip',
  'cursor',
  'distinct',
]);

interface ReadRequest {
  readonly model: string;
  readonly args: ReadArgs;
}

function parseReadRequest(body: unknown, limits: ArgsTreeLimits): ReadRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ReadValidationError('', '', 'Request body must be a JSON object: { model, args }.');
  }
  const record = body as Record<string, unknown>;
  const extraTopLevel = Object.keys(record).filter((k) => k !== 'model' && k !== 'args');
  if (extraTopLevel.length > 0) {
    throw new ReadValidationError(
      '',
      '',
      `Unknown top-level key(s) in request body: ${extraTopLevel.join(', ')}.`,
    );
  }

  const { model } = record;
  if (typeof model !== 'string' || model.length === 0) {
    throw new ReadValidationError('', '', '"model" must be a non-empty string.');
  }

  const rawArgs = record.args ?? {};
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
    throw new ReadValidationError(model, '', '"args" must be an object.');
  }

  // Bounded, cheap walk BEFORE anything in scopeRead/normalize() touches this tree.
  checkArgsTreeBounds(rawArgs, limits, model);

  const extraArgKeys = Object.keys(rawArgs).filter((k) => !KNOWN_ARG_KEYS.has(k));
  if (extraArgKeys.length > 0) {
    throw new ReadValidationError(
      model,
      '',
      `Unknown key(s) in "args": ${extraArgKeys.join(', ')}.`,
    );
  }

  return { model, args: rawArgs as ReadArgs };
}

export function createPgbaseReadController(prefix: string): Type<unknown> {
  @Controller(prefix)
  class PgbaseReadController {
    constructor(
      private readonly reads: PgbaseReadService,
      @Inject(PGBASE_OPTIONS) private readonly options: PgbaseModuleOptions,
      @Inject(PGBASE_WIRE_CODEC) private readonly wire: WireCodec,
    ) {}

    @Post('read')
    @HttpCode(200)
    async handle(@Body() body: unknown): Promise<unknown> {
      const limits = this.options.argsLimits ?? DEFAULT_ARGS_TREE_LIMITS;
      const { model, args } = parseReadRequest(body, limits);
      const result = await this.reads.read(model, args);
      // The view type promises Row's own field types (bigint, Decimal, Date, ...) — encode at
      // the transport boundary, not inside the read pipeline, so ScopedPrisma callers in-process
      // still get those real types back.
      return this.wire.serialize(result);
    }
  }
  return PgbaseReadController;
}
