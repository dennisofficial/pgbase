export class PgbaseHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PgbaseHttpError';
  }
}

export class PgbaseSubscribeError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name || 'PgbaseSubscribeError';
  }
}
