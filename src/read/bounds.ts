import { ReadValidationError } from './types.js';

export interface ArgsTreeLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export const DEFAULT_ARGS_TREE_LIMITS: ArgsTreeLimits = {
  maxDepth: 12,
  maxNodes: 2_000,
};

export function checkArgsTreeBounds(args: unknown, limits: ArgsTreeLimits, model: string): void {
  walk(args, limits, model, { count: 0 }, 0, '');
}

function walk(
  value: unknown,
  limits: ArgsTreeLimits,
  model: string,
  counter: { count: number },
  depth: number,
  path: string,
): void {
  if (value === null || typeof value !== 'object') return;

  if (depth > limits.maxDepth) {
    throw new ReadValidationError(
      model,
      path,
      `"args" nests deeper than ${limits.maxDepth} levels at "${path || '<root>'}".`,
    );
  }
  counter.count++;
  if (counter.count > limits.maxNodes) {
    throw new ReadValidationError(
      model,
      path,
      `"args" has more than ${limits.maxNodes} object/array nodes.`,
    );
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, limits, model, counter, depth + 1, `${path}[${i}]`));
  } else {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, limits, model, counter, depth + 1, path ? `${path}.${key}` : key);
    }
  }
}
