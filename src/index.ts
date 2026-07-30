/**
 * pgbase core.
 *
 * Everything exported here must run in BOTH Node and the browser: the same `evaluate` tests WAL
 * tuples on the server and fans a socket-level subscription out to component queries on the
 * client (docs/DESIGN.md §10.1). Keep this entry free of `pg`, `@prisma/client`, and `@nestjs/*`.
 */

export {};
