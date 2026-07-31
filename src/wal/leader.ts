import type { Client, ClientConfig, Pool } from 'pg';
import { LogicalReplicationService } from 'pg-logical-replication';
import type { ResolvedSchema } from '../schema/types.js';
import { decodeDelete, decodeInsert, decodeUpdate } from './decode.js';
import type {
  DeleteMessage,
  InsertMessage,
  PgoutputMessage,
  RelationMessage,
  UpdateMessage,
} from './pgoutput-messages.js';
import { PgoutputDecoder } from './pgoutput.js';
import {
  WalConfigurationError,
  WalDecodeError,
  type ChangeEvent,
  type ChangeKind,
  type LeaderState,
  type WalEvent,
  type WalLeader,
  type WalLeaderOptions,
  type WalLeaderStats,
} from './types.js';

const DEFAULT_ACQUIRE_RETRY_MS = 300;
const DEFAULT_STATUS_INTERVAL_MS = 10_000;
const ACQUIRE_ATTEMPT_TIMEOUT_MS = 5_000;

export interface WalLeaderDependencies {
  readonly pool: Pool;
  readonly replicationConfig: ClientConfig;
  readonly schema: ResolvedSchema;
}

class WalPgoutputPlugin {
  readonly options: { readonly publication: string };
  private readonly decoder = new PgoutputDecoder();

  constructor(publication: string) {
    this.options = { publication };
  }

  get name(): string {
    return 'pgoutput';
  }

  parse(buffer: Buffer): PgoutputMessage {
    return this.decoder.parse(buffer);
  }

  start(client: Client, slotName: string, lastLsn: string): Promise<unknown> {
    const options = [
      `proto_version '1'`,
      `publication_names '${this.options.publication}'`,
      `messages 'false'`,
    ];
    return client.query(
      `START_REPLICATION SLOT "${slotName}" LOGICAL ${lastLsn} (${options.join(', ')})`,
    );
  }

  relationFor(oid: number): RelationMessage | undefined {
    return this.decoder.relationFor(oid);
  }
}

export function createWalLeader(deps: WalLeaderDependencies, options: WalLeaderOptions): WalLeader {
  return new PgWalLeader(deps, options);
}

class PgWalLeader implements WalLeader {
  private readonly pool: Pool;
  private readonly replicationConfig: ClientConfig;
  private readonly schema: ResolvedSchema;
  private readonly options: WalLeaderOptions;

  private readonly handlers = new Set<(event: WalEvent) => void>();
  private mutableStats: WalLeaderStats = {
    state: 'idle',
    lastLsn: null,
    lastCommitAt: null,
    changesEmitted: 0,
    resyncsEmitted: 0,
    acquireAttempts: 0,
  };

  private service: LogicalReplicationService | null = null;
  private currentPlugin: WalPgoutputPlugin | null = null;
  private currentXact: { commitLsn: string; commitTime: bigint } | null = null;
  private lastCommitEndLsn: string | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private everStreamed = false;

  private stopped = true;
  private stopWaiters: Array<() => void> = [];
  private loopPromise: Promise<void> | null = null;

  constructor(deps: WalLeaderDependencies, options: WalLeaderOptions) {
    this.pool = deps.pool;
    this.replicationConfig = deps.replicationConfig;
    this.schema = deps.schema;
    this.options = options;
  }

  get stats(): WalLeaderStats {
    return this.mutableStats;
  }

  on(handler: (event: WalEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    await this.validateConfiguration();
    await this.reconcileSlot();

    this.stopped = false;
    this.service = new LogicalReplicationService(this.replicationConfig, {
      acknowledge: { auto: false, timeoutSeconds: 0 },
    });
    this.service.on('data', (lsn: string, message: PgoutputMessage) => this.onData(lsn, message));
    this.service.on('error', () => {});
    this.service.on('heartbeat', (_lsn: string, _timestamp: number, shouldRespond: boolean) => {
      if (shouldRespond) this.acknowledgeCurrentPosition();
    });

    this.loopPromise = this.runAcquireLoop();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const wake of this.stopWaiters.splice(0)) wake();

    this.stopStatusInterval();
    if (this.service) {
      await this.service
        .acknowledge(this.lastCommitEndLsn ?? this.service.lastLsn())
        .catch(() => {});
    }
    if (this.service) await this.service.stop().catch(() => {});
    if (this.loopPromise) await this.loopPromise.catch(() => {});

    this.service = null;
    this.currentPlugin = null;
    this.setState('stopped');
  }

  // ── validation ──────────────────────────────────────────────────────────────────────────────

  private async validateConfiguration(): Promise<void> {
    const walLevel = await this.pool.query<{ wal_level: string }>('SHOW wal_level');
    const level = walLevel.rows[0]?.wal_level;
    if (level !== 'logical') {
      throw new WalConfigurationError(
        `wal_level is "${level}", not "logical". Logical decoding requires wal_level = logical in ` +
          `postgresql.conf, which needs a server restart to take effect.`,
      );
    }

    const pub = await this.pool.query<{ puballtables: boolean }>(
      'SELECT puballtables FROM pg_publication WHERE pubname = $1',
      [this.options.publication],
    );
    if (pub.rowCount === 0) {
      throw new WalConfigurationError(
        `No publication named "${this.options.publication}" exists. Run ` +
          `"CREATE PUBLICATION ${this.options.publication} FOR ALL TABLES" (or FOR TABLE ...) first.`,
      );
    }
    if (pub.rows[0]!.puballtables) return;

    const members = await this.pool.query<{
      namespace: string;
      table: string;
      has_column_list: boolean;
    }>(
      `
      SELECT n.nspname AS namespace, c.relname AS table, (pr.prattrs IS NOT NULL) AS has_column_list
      FROM pg_publication_rel pr
      JOIN pg_publication p ON p.oid = pr.prpubid
      JOIN pg_class c ON c.oid = pr.prrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE p.pubname = $1
      `,
      [this.options.publication],
    );

    const columnListed = members.rows.filter((r) => r.has_column_list);
    if (columnListed.length > 0) {
      throw new WalConfigurationError(
        `Publication "${this.options.publication}" restricts columns on ` +
          `${columnListed.map((r) => `"${r.namespace}.${r.table}"`).join(', ')}. A column-restricted ` +
          `publication silently omits the excluded columns from every tuple on the wire — the WAL ` +
          `leader's positional decode has no way to tell "excluded" from "not this table" and would ` +
          `misattribute values to the wrong column. Drop the column list from this publication.`,
      );
    }

    const unmodeled = members.rows.filter(
      (r) => !this.schema.byTable.has(`${r.namespace}.${r.table}`),
    );
    if (unmodeled.length > 0) {
      throw new WalConfigurationError(
        `Publication "${this.options.publication}" includes ` +
          `${unmodeled.map((r) => `"${r.namespace}.${r.table}"`).join(', ')}, which ${unmodeled.length > 1 ? 'are' : 'is'} ` +
          `not in the resolved schema. Every published table must have a model, or the leader has no ` +
          `way to interpret its Relation/row messages. Remove it from the publication, or add it to ` +
          `the Prisma schema and regenerate.`,
      );
    }
  }

  private async reconcileSlot(): Promise<void> {
    const { rows } = await this.pool.query<{ wal_status: string | null }>(
      'SELECT wal_status FROM pg_replication_slots WHERE slot_name = $1',
      [this.options.slotName],
    );
    const row = rows[0];
    if (row && row.wal_status !== 'lost') return;

    if (!row && !this.everStreamed) {
      await this.pool.query('SELECT pg_create_logical_replication_slot($1, $2)', [
        this.options.slotName,
        'pgoutput',
      ]);
      return;
    }

    const reason = row
      ? `wal_status="lost" (likely max_slot_wal_keep_size)`
      : 'the slot no longer exists';
    if (row) {
      await this.pool
        .query('SELECT pg_drop_replication_slot($1)', [this.options.slotName])
        .catch(() => {});
    }
    await this.pool.query('SELECT pg_create_logical_replication_slot($1, $2)', [
      this.options.slotName,
      'pgoutput',
    ]);
    this.lastCommitEndLsn = null;
    this.emit({
      type: 'resync',
      resync: {
        reason: 'slot-recreated',
        detail:
          `Replication slot "${this.options.slotName}" was invalidated (${reason}) and has been ` +
          `recreated. Every subscriber must be treated as stale and resynced from a fresh snapshot.`,
        tables: 'all',
        lsn: null,
      },
    });
    this.mutableStats = {
      ...this.mutableStats,
      resyncsEmitted: this.mutableStats.resyncsEmitted + 1,
    };
  }

  // ── leader election / acquire loop ─────────────────────────────────────────────────────────

  private async runAcquireLoop(): Promise<void> {
    while (!this.stopped) {
      this.setState('acquiring');
      this.mutableStats = {
        ...this.mutableStats,
        acquireAttempts: this.mutableStats.acquireAttempts + 1,
      };

      await this.reconcileSlot();
      const plugin = new WalPgoutputPlugin(this.options.publication);
      this.currentPlugin = plugin;
      const service = this.service!;

      let onStart: (() => void) | null = null;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      try {
        const started = new Promise<void>((resolve) => {
          onStart = () => resolve();
          service.once('start', onStart);
        });
        const ended = service.subscribe(plugin as never, this.options.slotName, '0/00000000');
        const timedOut = Symbol('acquire-timeout');
        const timeout = new Promise<typeof timedOut>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(timedOut), ACQUIRE_ATTEMPT_TIMEOUT_MS);
          timeoutHandle.unref?.();
        });
        const outcome = await Promise.race([started, ended, timeout]);
        if (outcome === timedOut) {
          await service.stop().catch(() => {});
          throw new Error(`Attach attempt exceeded ${ACQUIRE_ATTEMPT_TIMEOUT_MS}ms.`);
        }
        this.setState('streaming');
        this.everStreamed = true;
        this.startStatusInterval(service);
        await ended;
      } catch {
        // Acquisition failed, or an already-streaming connection dropped. Either way: back off
        // and retry — a second instance takes over the moment the slot frees up.
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (onStart) service.off('start', onStart);
        this.stopStatusInterval();
        this.currentPlugin = null;
        this.currentXact = null;
      }

      if (this.stopped) break;
      this.setState('backoff');
      await this.waitUnlessStopped(this.options.acquireRetryMs ?? DEFAULT_ACQUIRE_RETRY_MS);
    }
    this.setState('stopped');
  }

  private async waitUnlessStopped(ms: number): Promise<void> {
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.stopWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private acknowledgeCurrentPosition(): void {
    const service = this.service;
    if (!service) return;
    const lsn = this.lastCommitEndLsn ?? service.lastLsn();
    setImmediate(() => {
      if (this.service !== service) return; // superseded by a reconnect while this was queued
      void service.acknowledge(lsn).catch(() => {});
    });
  }

  private startStatusInterval(service: LogicalReplicationService): void {
    const ms = this.options.statusIntervalMs ?? DEFAULT_STATUS_INTERVAL_MS;
    this.statusTimer = setInterval(() => {
      this.acknowledgeCurrentPosition();
      void this.pool
        .query<{ wal_status: string | null }>(
          'SELECT wal_status FROM pg_replication_slots WHERE slot_name = $1',
          [this.options.slotName],
        )
        .then(({ rows }) => {
          if (rows.length === 0 || rows[0]!.wal_status === 'lost') void service.stop();
        })
        .catch(() => {});
    }, ms);
    this.statusTimer.unref?.();
  }

  private stopStatusInterval(): void {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  private setState(state: LeaderState): void {
    this.mutableStats = { ...this.mutableStats, state };
  }

  // ── message handling ───────────────────────────────────────────────────────────────────────

  private onData(lsn: string, message: PgoutputMessage): void {
    switch (message.tag) {
      case 'begin':
        this.currentXact = { commitLsn: message.commitLsn, commitTime: message.commitTime };
        break;
      case 'commit':
        this.lastCommitEndLsn = message.commitEndLsn;
        this.currentXact = null;
        this.mutableStats = {
          ...this.mutableStats,
          lastLsn: message.commitEndLsn,
          lastCommitAt: message.commitTime,
        };
        break;
      case 'insert':
      case 'update':
      case 'delete':
        this.onRowChange(lsn, message);
        break;
      case 'truncate':
        this.onTruncate(lsn, message.relationOids);
        break;
      case 'stream':
        this.emit({
          type: 'resync',
          resync: {
            reason: 'streamed-transaction',
            detail:
              `Received a protocol v2 stream-${message.kind} message; this leader requests ` +
              `proto_version 1 and cannot decode streamed (in-progress) transactions.`,
            tables: 'all',
            lsn,
          },
        });
        this.mutableStats = {
          ...this.mutableStats,
          resyncsEmitted: this.mutableStats.resyncsEmitted + 1,
        };
        break;
      case 'relation':
      case 'origin':
      case 'type':
      case 'message':
        break;
    }
  }

  private onRowChange(lsn: string, message: InsertMessage | UpdateMessage | DeleteMessage): void {
    const relation = this.currentPlugin?.relationFor(message.relationOid);
    if (!relation) return; // e.g. a FOR ALL TABLES publication decoding a table we have no model for
    const model = this.schema.byTable.get(`${relation.schema}.${relation.name}`);
    if (!model) return;

    if (!this.currentXact) {
      throw new WalDecodeError(model.table, 'Received a row change outside of a BEGIN…COMMIT.');
    }

    try {
      const kind: ChangeKind = message.tag;
      const decoded =
        message.tag === 'insert'
          ? decodeInsert(model, message)
          : message.tag === 'update'
            ? decodeUpdate(model, message)
            : decodeDelete(model, message);

      const change: ChangeEvent = {
        kind,
        model: model.model,
        table: model.table,
        schema: model.namespace,
        lsn,
        commitLsn: this.currentXact.commitLsn,
        commitTime: this.currentXact.commitTime,
        newRow: decoded.newRow,
        oldRow: decoded.oldRow,
        unknownColumns: decoded.unknownColumns,
      };
      this.mutableStats = {
        ...this.mutableStats,
        changesEmitted: this.mutableStats.changesEmitted + 1,
        lastLsn: lsn,
      };
      this.emit({ type: 'change', change });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.emit({
        type: 'resync',
        resync: { reason: 'decode-gap', detail, tables: [model.model], lsn },
      });
      this.mutableStats = {
        ...this.mutableStats,
        resyncsEmitted: this.mutableStats.resyncsEmitted + 1,
      };
    }
  }

  private onTruncate(lsn: string, relationOids: readonly number[]): void {
    const tables = relationOids.map((oid) => {
      const relation = this.currentPlugin?.relationFor(oid);
      if (!relation) return `oid:${oid}`;
      return (
        this.schema.byTable.get(`${relation.schema}.${relation.name}`)?.model ??
        `${relation.schema}.${relation.name}`
      );
    });
    this.emit({
      type: 'resync',
      resync: {
        reason: 'truncate',
        detail: `TRUNCATE affecting ${tables.join(', ')}.`,
        tables,
        lsn,
      },
    });
    this.mutableStats = {
      ...this.mutableStats,
      resyncsEmitted: this.mutableStats.resyncsEmitted + 1,
    };
  }

  private emit(event: WalEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}
