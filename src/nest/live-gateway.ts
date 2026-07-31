import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { MemoryClaimsCache, type ContextStore } from '../context/index.js';
import { DEFAULT_ARGS_TREE_LIMITS, type WireCodec } from '../read/index.js';
import type { PgbaseLiveRuntimeOptions } from './live-runtime.js';
import { PgbaseLiveRuntime } from './live-runtime.js';
import { PgbaseReadService } from './read-service.js';
import type { Resolved } from './tokens.js';
import {
  PGBASE_CLAIMS_CACHE,
  PGBASE_CONTEXT_STORE,
  PGBASE_OPTIONS,
  PGBASE_RESOLVED,
  PGBASE_WIRE_CODEC,
} from './tokens.js';
import type { PgbaseModuleOptions } from './types.js';

@Injectable()
export class PgbaseLiveGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private runtime: PgbaseLiveRuntime | null = null;

  constructor(
    @Inject(PGBASE_OPTIONS) private readonly options: PgbaseModuleOptions,
    @Inject(PGBASE_RESOLVED) private readonly resolved: Resolved,
    @Inject(PGBASE_CONTEXT_STORE) private readonly contextStore: ContextStore,
    @Inject(PGBASE_CLAIMS_CACHE) private readonly claimsCache: MemoryClaimsCache,
    @Inject(PGBASE_WIRE_CODEC) private readonly wire: WireCodec,
    private readonly reads: PgbaseReadService,
    @Optional() private readonly httpAdapterHost?: HttpAdapterHost,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.options.live) return;
    const httpServer = this.httpAdapterHost?.httpAdapter?.getHttpServer();
    if (!httpServer) {
      throw new Error(
        'PgbaseLiveGateway: no HTTP server available from HttpAdapterHost. Live subscriptions need ' +
          'an HTTP server to attach socket.io to — this module must run inside a Nest HTTP application.',
      );
    }

    const opts: PgbaseLiveRuntimeOptions = {
      httpServer,
      pool: this.options.pool,
      schema: this.resolved.schema,
      policies: this.resolved.policies,
      reads: this.reads,
      contextStore: this.contextStore,
      claims: this.claimsCache,
      wire: this.wire,
      getPrincipal: this.options.getPrincipal,
      wal: this.options.live,
      argsLimits: this.options.argsLimits ?? DEFAULT_ARGS_TREE_LIMITS,
      readLimits: this.options.limits,
      socketIoOptions: this.options.live.socketIoOptions,
    };
    this.runtime = new PgbaseLiveRuntime(opts);
    await this.runtime.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runtime?.stop();
    this.runtime = null;
  }
}
