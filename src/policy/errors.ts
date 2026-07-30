export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyValidationError';
  }
}
