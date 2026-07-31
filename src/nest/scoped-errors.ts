export class ScopedRowNotFoundError extends Error {
  constructor(readonly model: string) {
    super(
      `No ${model} matching that filter is visible to this caller. Either it does not exist, or ` +
        `it belongs to someone else — a write cannot distinguish the two without disclosing which.`,
    );
    this.name = 'ScopedRowNotFoundError';
  }
}
