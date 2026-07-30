export class SchemaResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaResolutionError';
  }
}
