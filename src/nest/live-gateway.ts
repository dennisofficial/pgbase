import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { ClientConfig } from 'pg';
import { AsyncLocalStorageContextStore, MemoryClaimsCache } from '../context/index.js';
import { DEFAULT_ARGS_TREE_LIMITS } from '../read/index.js';
import { DEFAULT_PUBLICATION } from '../schema/index.js';
import type { PgbaseLiveRuntimeOptions } from './live-runtime.js';
import { PgbaseLiveRuntime } from './live-runtime.js';
import { PgbasePoolHost } from './pool.js';
import { PgbaseReadService } from './read-service.js';
import { PgbaseSchemaRegistry } from './schema-registry.js';
import { PGBASE_OPTIONS } from './tokens.js';
import type { PgbaseModuleOptions } from './types.js';
import { PgbaseWireCodecService } from './wire-codec.js';

@Injectable()
export class PgbaseLiveGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(this.constructor.name);
  private runtime: PgbaseLiveRuntime | null = null;

  constructor(
    @Inject(PGBASE_OPTIONS) private readonly options: PgbaseModuleOptions,
    private readonly resolved: PgbaseSchemaRegistry,
    private readonly contextStore: AsyncLocalStorageContextStore,
    private readonly claimsCache: MemoryClaimsCache,
    private readonly wire: PgbaseWireCodecService,
    private readonly reads: PgbaseReadService,
    private readonly poolHost: PgbasePoolHost,
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
      pool: this.poolHost.pool,
      schema: this.resolved.schema,
      policies: this.resolved.policies,
      reads: this.reads,
      contextStore: this.contextStore,
      claims: this.claimsCache,
      wire: this.wire,
      decimalConstructor: this.options.decimalConstructor,
      getPrincipal: this.options.getPrincipal,
      wal: {
        ...this.options.live,
        publication: this.options.publication ?? DEFAULT_PUBLICATION,
        replicationConfig: this.replicationConfig(),
      },
      argsLimits: this.options.argsLimits ?? DEFAULT_ARGS_TREE_LIMITS,
      readLimits: this.options.limits,
      socketIoOptions: this.options.live.socketIoOptions,
    };
    this.runtime = new PgbaseLiveRuntime(opts);
    await this.runtime.start();
    this.warnIfShutdownHooksDisabled();
  }

  private replicationConfig(): ClientConfig {
    const explicit = this.options.live?.replicationConfig;
    if (explicit) return explicit;
    if (this.options.connectionString) {
      return { connectionString: this.options.connectionString };
    }
    throw new Error(
      'PgbaseModule: live subscriptions need "live.replicationConfig" when the module was given a ' +
        '"pool" rather than a "connectionString". Point it at the primary directly — a ' +
        'transaction pooler cannot carry the replication protocol.',
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runtime?.stop();
    this.runtime = null;
  }

  private warnIfShutdownHooksDisabled(): void {
    if (process.listenerCount('SIGTERM') > 0) return;
    this.logger.warn(
      '[pgbase] Live subscriptions are running but nothing is listening for SIGTERM, which means ' +
        'app.enableShutdownHooks() was probably not called. Add it in main.ts: without it the WAL ' +
        'leader cannot release its replication slot on shutdown, and a standby cannot take over ' +
        'until Postgres times the dead connection out (wal_sender_timeout).',
    );
  }
}
