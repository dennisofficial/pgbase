import { randomUUID } from 'node:crypto';
import type { Server as NodeHttpServer } from 'node:http';
import type { ClientConfig, Pool } from 'pg';
import { Server as SocketIOServer, type Socket as IoSocket, type ServerOptions } from 'socket.io';
import type { ClaimsCache, ContextStore } from '../context/index.js';
import {
  PGBASE_DELTA,
  PGBASE_SUBSCRIBE,
  PGBASE_UNSUBSCRIBE,
  keyOf,
  type SubscribeAck,
  type SubscribeRequest,
  type UnsubscribeAck,
  type UnsubscribeRequest,
  type WireError,
} from '../live/protocol.js';
import { InMemorySubscriptionRegistry } from '../live/registry.js';
import { DefaultChangeRouter } from '../live/router.js';
import { InMemoryChangeSink } from '../live/sink.js';
import { createSubscription } from '../live/subscription.js';
import type { Delta } from '../live/types.js';
import type { ValidatedPolicy } from '../policy/index.js';
import {
  DEFAULT_ARGS_TREE_LIMITS,
  DEFAULT_READ_LIMITS,
  ReadValidationError,
  checkArgsTreeBounds,
  type ArgsTreeLimits,
  type ReadLimits,
  type WireCodec,
} from '../read/index.js';
import type { ResolvedModel, ResolvedSchema } from '../schema/types.js';
import { createWalLeader } from '../wal/leader.js';
import type { WalLeader, WalLeaderStats } from '../wal/types.js';
import type { PgbaseReadService } from './read-service.js';

export interface LiveWalOptions {
  readonly replicationConfig: ClientConfig;
  readonly slotName: string;
  readonly publication: string;
  readonly acquireRetryMs?: number;
  readonly statusIntervalMs?: number;
}

export interface PgbaseLiveRuntimeOptions {
  readonly httpServer: NodeHttpServer;
  readonly pool: Pool;
  readonly schema: ResolvedSchema;
  readonly policies: ReadonlyMap<string, ValidatedPolicy>;
  readonly reads: PgbaseReadService;
  readonly contextStore: ContextStore;
  readonly claims: ClaimsCache;
  readonly wire: WireCodec;
  readonly getPrincipal: (req: unknown) => unknown;
  readonly wal: LiveWalOptions;
  readonly argsLimits?: ArgsTreeLimits;
  readonly readLimits?: ReadLimits;
  readonly socketIoOptions?: Partial<ServerOptions>;
}

interface SocketState {
  readonly principal: unknown;
  readonly claims: unknown;
  readonly owned: Set<string>;
}

function primaryKeyFields(model: ResolvedModel): readonly string[] {
  return model.primaryKey.map((column) => model.byColumn.get(column)?.name ?? column);
}

function toWireError(err: unknown): WireError {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'Error', message: String(err) };
}

export class PgbaseLiveRuntime {
  private readonly registry = new InMemorySubscriptionRegistry();
  private readonly router: DefaultChangeRouter;
  private readonly sink = new InMemoryChangeSink();
  private readonly leader: WalLeader;
  private readonly io: SocketIOServer;

  private readonly dispatch = new Map<string, (delta: Delta) => void>();
  private readonly unregisterById = new Map<string, () => void>();
  private readonly bySocket = new Map<string, SocketState>();

  private stopSink: (() => void) | null = null;

  constructor(private readonly opts: PgbaseLiveRuntimeOptions) {
    this.router = new DefaultChangeRouter(this.registry);
    this.leader = createWalLeader(
      { pool: opts.pool, replicationConfig: opts.wal.replicationConfig, schema: opts.schema },
      {
        slotName: opts.wal.slotName,
        publication: opts.wal.publication,
        acquireRetryMs: opts.wal.acquireRetryMs,
        statusIntervalMs: opts.wal.statusIntervalMs,
      },
    );
    this.io = new SocketIOServer(opts.httpServer, opts.socketIoOptions);
  }

  get stats(): WalLeaderStats {
    return this.leader.stats;
  }

  /** Live subscription count across every connected socket — for tests and ops metrics. */
  get subscriptionCount(): number {
    return this.registry.size;
  }

  async start(): Promise<void> {
    this.leader.on((event) => this.sink.push(event));
    this.stopSink = this.sink.onEvent((event) => {
      const result =
        event.type === 'change'
          ? this.router.route(event.change)
          : this.router.routeResync(event.resync);
      for (const delta of result.deltas) this.dispatch.get(delta.subscriptionId)?.(delta);
    });

    this.io.use((socket, next) => {
      void this.authenticate(socket)
        .then(() => next())
        .catch((err) => next(err instanceof Error ? err : new Error(String(err))));
    });
    this.io.on('connection', (socket) => this.handleConnection(socket));

    await this.leader.start();
  }

  async stop(): Promise<void> {
    this.io.removeAllListeners();
    await new Promise<void>((resolve) => this.io.close(() => resolve()));
    this.stopSink?.();
    await this.leader.stop();
  }

  // ── connection lifecycle ───────────────────────────────────────────────────────────────────

  private async authenticate(socket: IoSocket): Promise<void> {
    const principal = this.opts.getPrincipal(socket.handshake);
    const claims = await this.opts.claims.get(principal);
    this.bySocket.set(socket.id, { principal, claims, owned: new Set() });
  }

  private handleConnection(socket: IoSocket): void {
    socket.on(PGBASE_SUBSCRIBE, (req: unknown, ack: (res: SubscribeAck) => void) => {
      void this.handleSubscribe(socket, req).then(ack);
    });
    socket.on(PGBASE_UNSUBSCRIBE, (req: unknown, ack: (res: UnsubscribeAck) => void) => {
      ack(this.handleUnsubscribe(socket, req));
    });
    socket.on('disconnect', () => {
      const state = this.bySocket.get(socket.id);
      if (state) for (const id of state.owned) this.teardown(id);
      this.bySocket.delete(socket.id);
    });
  }

  // ── subscribe: the snapshot/stream seam ────────────────────────────────────────────────────

  private async handleSubscribe(socket: IoSocket, raw: unknown): Promise<SubscribeAck> {
    const state = this.bySocket.get(socket.id);
    if (!state)
      return { ok: false, error: { name: 'Error', message: 'Socket has no resolved claims.' } };

    let id: string | undefined;
    try {
      const { model, where } = this.parseSubscribeRequest(raw);
      const resolvedModel = this.opts.schema.byModel.get(model);
      if (!resolvedModel) {
        throw new ReadValidationError(
          model,
          '',
          `Model "${model}" is not part of the resolved schema.`,
        );
      }
      const validated = this.opts.policies.get(model);
      if (!validated) {
        throw new ReadValidationError(
          model,
          '',
          `Model "${model}" has no client-accessible policy — either NO_CLIENT_ACCESS or missing ` +
            `from the registry. A model without a policy cannot be subscribed to.`,
        );
      }
      checkArgsTreeBounds(
        { where: where ?? {} },
        this.opts.argsLimits ?? DEFAULT_ARGS_TREE_LIMITS,
        model,
      );

      id = randomUUID();
      const buffer: Delta[] = [];
      let live = false;
      this.dispatch.set(id, (delta) => {
        if (live) this.forward(socket, delta);
        else buffer.push(delta);
      });
      const clientWhere = (where ?? {}) as Record<string, unknown>;
      const unregister = this.registry.add(
        createSubscription({
          id,
          model: resolvedModel,
          policy: validated.policy,
          claims: state.claims,
          where: clientWhere,
        }),
      );
      this.unregisterById.set(id, unregister);
      state.owned.add(id);

      const pkFields = primaryKeyFields(resolvedModel);
      const rows = (await this.opts.contextStore.run(
        { principal: state.principal, claims: state.claims },
        () => this.opts.reads.read(model, { where: clientWhere }),
      )) as readonly Record<string, unknown>[];

      // The snapshot is capped at `maxRows`, but the live predicate is not: a change to any
      // matching row is routed, including rows the cap excluded. A client would then hold its
      // first `maxRows` rows plus an arbitrary scattering of later ones — a set matching no read.
      // Live queries have no cursor yet (DESIGN §8), so there is no correct way to serve this;
      // refuse it rather than hand back a cache that is quietly wrong.
      const maxRows = (this.opts.readLimits ?? DEFAULT_READ_LIMITS).maxRows;
      if (rows.length >= maxRows) {
        throw new Error(
          `Live subscription to "${model}" matches at least ${maxRows} rows, the ` +
            `snapshot cap. Live queries have no pagination, so beyond the cap the initial rows and ` +
            `the streamed changes would describe different sets. Narrow the filter, or use a ` +
            `one-shot read if you need the whole table.`,
        );
      }

      const snapshotState = new Map<string, unknown>();
      for (const row of rows) snapshotState.set(keyOf(pkFields, row), row);

      let bufferedResync: Delta | undefined;
      for (const delta of buffer) {
        if (delta.kind === 'upsert') {
          snapshotState.set(keyOf(pkFields, delta.row as Record<string, unknown>), delta.row);
        } else if (delta.kind === 'remove') {
          snapshotState.delete(keyOf(pkFields, delta.key));
        } else {
          bufferedResync = delta;
        }
      }
      live = true;

      if (bufferedResync) {
        const resync = bufferedResync;
        queueMicrotask(() => this.forward(socket, resync));
      }

      return {
        ok: true,
        subscriptionId: id,
        primaryKey: pkFields,
        snapshot: this.opts.wire.serialize([...snapshotState.values()]),
      };
    } catch (err) {
      if (id) {
        state.owned.delete(id);
        this.teardown(id);
      }
      return { ok: false, error: toWireError(err) };
    }
  }

  private handleUnsubscribe(socket: IoSocket, raw: unknown): UnsubscribeAck {
    const state = this.bySocket.get(socket.id);
    const { subscriptionId } = raw as UnsubscribeRequest;
    if (!state || typeof subscriptionId !== 'string' || !state.owned.has(subscriptionId)) {
      return { ok: false, error: { name: 'Error', message: 'Unknown subscription id.' } };
    }
    state.owned.delete(subscriptionId);
    this.teardown(subscriptionId);
    return { ok: true };
  }

  private teardown(id: string): void {
    this.dispatch.delete(id);
    this.unregisterById.get(id)?.();
    this.unregisterById.delete(id);
  }

  private forward(socket: IoSocket, delta: Delta): void {
    socket.emit(PGBASE_DELTA, this.opts.wire.serialize(delta));
  }

  private parseSubscribeRequest(raw: unknown): SubscribeRequest {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ReadValidationError(
        '',
        '',
        'Subscribe payload must be an object: { model, where }.',
      );
    }
    const record = raw as Record<string, unknown>;
    const extra = Object.keys(record).filter((k) => k !== 'model' && k !== 'where');
    if (extra.length > 0) {
      throw new ReadValidationError(
        '',
        '',
        `Unknown key(s) in subscribe payload: ${extra.join(', ')}.`,
      );
    }
    const { model } = record;
    if (typeof model !== 'string' || model.length === 0) {
      throw new ReadValidationError('', '', '"model" must be a non-empty string.');
    }
    return { model, where: record.where };
  }
}
