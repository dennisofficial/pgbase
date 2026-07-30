import type {
  LiveBoolFilter,
  LiveListFilter,
  LiveNullableScalarFilter,
  LiveNullableStringFilter,
  LiveScalarFilter,
  LiveStringFilter,
  LiveWhere,
} from '@workspace/pgbase/query';
import type { Prisma } from './generated/prisma/client.js';
import { JobStatus } from './generated/prisma/enums.js';

/**
 * Compile-time proof that pgbase's wire filters are a SUBSET of Prisma's, so a `where` written
 * once is valid in both server (Prisma) and client (pgbase) code.
 *
 * There is no runtime here on purpose — `tsc --noEmit` on this package is the assertion. If Prisma
 * changes a filter shape, or pgbase's drifts from it, this file stops compiling.
 *
 * Note the direction: pgbase ⊆ Prisma, never the reverse. Prisma has operators pgbase does not
 * implement (relation filters, JSON path filters), and pgbase must not silently inherit them —
 * see docs/DESIGN.md §14.9.
 */

declare function assignableToPrisma<P>(value: P): void;

declare const stringFilter: LiveStringFilter;
declare const nullableStringFilter: LiveNullableStringFilter;
declare const boolFilter: LiveBoolFilter;
declare const dateFilter: LiveScalarFilter<Date>;
declare const nullableDateFilter: LiveNullableScalarFilter<Date>;
declare const bigintFilter: LiveScalarFilter<bigint>;
declare const decimalFilter: LiveScalarFilter<Prisma.Decimal>;
declare const listFilter: LiveListFilter<string>;
declare const where: LiveWhere;

export function _conformance(): void {
  // Nullable and non-nullable are separate types in Prisma, and only the nullable variants accept
  // `equals: null`. pgbase mirrors that split rather than allowing null everywhere.
  assignableToPrisma<Prisma.StringFilter<'Job'>>(stringFilter);
  assignableToPrisma<Prisma.StringNullableFilter<'User'>>(nullableStringFilter);
  assignableToPrisma<Prisma.BoolFilter<'Task'>>(boolFilter);
  assignableToPrisma<Prisma.DateTimeFilter<'Job'>>(dateFilter);
  assignableToPrisma<Prisma.DateTimeNullableFilter<'Job'>>(nullableDateFilter);
  assignableToPrisma<Prisma.BigIntFilter<'Invoice'>>(bigintFilter);
  assignableToPrisma<Prisma.DecimalFilter<'Invoice'>>(decimalFilter);
  assignableToPrisma<Prisma.StringNullableListFilter<'Job'>>(listFilter);

  // The boolean combinators, including Prisma's singular-or-array forms.
  assignableToPrisma<Prisma.JobWhereInput>({ AND: where });
  assignableToPrisma<Prisma.JobWhereInput>({ AND: [where, where] });
  assignableToPrisma<Prisma.JobWhereInput>({ OR: [where, where] });
  assignableToPrisma<Prisma.JobWhereInput>({ NOT: where });
  assignableToPrisma<Prisma.JobWhereInput>({ NOT: [where, where] });

  // A realistic query, typed by PRISMA, accepted by pgbase unchanged. This is the direction that
  // matters day to day: a `where` written for server code can be handed straight to a live
  // subscription without translation.
  const q: Prisma.JobWhereInput = {
    AND: [
      { status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } },
      { name: { contains: 'deploy', mode: 'insensitive' } },
      { closedAt: { equals: null } },
      { labels: { hasSome: ['urgent', 'p0'] } },
      { NOT: { priority: { lt: 5 } } },
    ],
  };

  const _accepted: LiveWhere = q;
  void _accepted;
}
