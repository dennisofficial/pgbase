import { Transform } from 'class-transformer';

export const Trim = (): PropertyDecorator =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
