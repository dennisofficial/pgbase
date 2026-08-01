# CLAUDE.md — `src/wal/`

Turns the Postgres logical replication stream into `ChangeEvent`s the live router can judge.
`leader.ts` owns the connection; `pgoutput.ts` + `binary-reader.ts` parse the protocol;
`decode.ts` / `encode.ts` translate values.

## Three value representations — keep them straight

| form | produced by | shape |
| --- | --- | --- |
| **wire** | pgoutput | Postgres text output, plus `TOAST_UNCHANGED` for untransmitted columns |
| **internal** | `decodeColumn` | comparable form: timestamps as `bigint` microseconds, `numeric`/`int8` as strings, JSON `null` as the `JSON_NULL` symbol |
| **Prisma-facing** | `encodeColumn` | what a subscriber receives: `Date`, `Decimal` (via `decimalConstructor`), real `null` |

The internal form exists so `src/query/evaluate.ts` compares WAL tuples with exactly the semantics
`compileSql` gets from Postgres. **Predicates are evaluated on the internal form, and only rows
that survive are encoded** — never the reverse.

`decode` and `encode` must round-trip. Timestamps are floored to whole milliseconds on decode
precisely so the `bigint` micros → `Date` division in `encode` is exact in both directions; changing
one side without the other loses sub-millisecond fidelity asymmetrically.

`__tests__/decode-agreement.test.ts` is the guard that matters: it streams real values through a
real slot and asserts pgbase's WAL decode matches node-postgres's parse of the same column. A
divergence there means a read and a live update would report different values for one row.

## TOAST and replica identity

An unchanged TOASTed column is simply absent from the WAL. `decode` records those in
`ChangeEvent.unknownColumns` rather than guessing a value — the router turns an unknown column that
a predicate reads into a `resync` for that subscriber. Never substitute a default, and never drop
the column silently; both convert "I don't know" into a confident wrong answer.

`oldRow` is populated only under `REPLICA IDENTITY FULL`. Without it, a delete carries the primary
key alone. `src/live/` owns what to do about that (see its CLAUDE.md); this module's job is only to
report faithfully what the WAL did and did not contain.

## The leader

The replication slot **is** the leader lock — Postgres admits exactly one consumer per slot, so
instances that lose the race sit in `backoff` and retry. There is no lease table and nothing that
can disagree about who holds it. States: `idle | acquiring | streaming | backoff | stopped`.

Anything that breaks the continuity of the stream must surface as a `ResyncEvent` rather than a
gap. The four reasons are exhaustive and each maps to a real cause: `truncate` (TRUNCATE carries no
per-row information), `streamed-transaction` (in-progress `STREAM_*` messages are not decoded),
`slot-recreated` (the slot was invalidated, typically by `max_slot_wal_keep_size`), `decode-gap`.
Adding a fifth means the client protocol has a new case to handle.

Releasing the slot on shutdown is what makes a rolling deploy invisible instead of a
`wal_sender_timeout`-long blackout, and it depends on the consuming app calling
`app.enableShutdownHooks()`.

## Tests

These suites create real publications and replication slots on `:55433`. Always drop both in
`afterAll` via the `__tests__/support.ts` helpers — a leaked slot pins WAL (in tmpfs, so in RAM)
and starves later runs, which surface as unrelated timeouts. Slots and walsenders are capped and
single-consumer, which is why `fileParallelism` is off repo-wide.
