import type { PredicateNode } from './ast.js';

export function referencedColumns(node: PredicateNode, into = new Set<string>()): Set<string> {
  switch (node.kind) {
    case 'literal':
      break;
    case 'and':
    case 'or':
      for (const c of node.children) referencedColumns(c, into);
      break;
    case 'not':
      referencedColumns(node.child, into);
      break;
    case 'compare':
    case 'set':
    case 'list':
    case 'isNull':
      into.add(node.field.column);
      break;
  }
  return into;
}
