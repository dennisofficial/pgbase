import { PgbaseCore } from './core.js';
import { createModelAccessor } from './model-accessor.js';
import type {
  ConnectionStatus,
  CreateClientOptions,
  GetAuth,
  ModelAccessor,
  PgbaseClient,
} from './types.js';

function toGetAuth(value: GetAuth | Record<string, string> | undefined): GetAuth | undefined {
  return typeof value === 'function' ? value : value === undefined ? undefined : () => value;
}

export function createClient<Models extends object>(
  options: CreateClientOptions,
): PgbaseClient<Models> {
  const core = new PgbaseCore(options);
  const accessors = new Map<string, ModelAccessor<unknown>>();

  const client = new Proxy({} as Record<string, unknown>, {
    get(_target, prop): unknown {
      if (prop === '$status') return (): ConnectionStatus => core.status();
      if (prop === '$onStatusChange') return core.onStatusChange.bind(core);
      if (prop === '$setAuth')
        return (v: Parameters<typeof toGetAuth>[0]) => core.setAuth(toGetAuth(v));
      if (prop === '$dispose') return (): void => core.dispose();
      if (typeof prop !== 'string') return undefined;

      let accessor = accessors.get(prop);
      if (!accessor) {
        accessor = createModelAccessor(core, prop);
        accessors.set(prop, accessor);
      }
      return accessor;
    },
  });

  return client as PgbaseClient<Models>;
}
