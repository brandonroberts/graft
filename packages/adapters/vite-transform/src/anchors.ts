/**
 * Behavior-based anchors over ESTree ASTs (as produced by oxc-parser).
 *
 * An anchor locates exactly one node in a target file. Prefer anchors on stable,
 * observable things (exported symbols, public method names, user-facing strings)
 * over code shape. Anchors never match on formatting.
 */

export interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export interface Program extends AstNode {
  type: 'Program';
  body: AstNode[];
}

export interface AnchorScope {
  program: Program;
  code: string;
  /** Target file, relative to the package root. */
  file: string;
}

export interface AnchorDefinition {
  /** What this anchor locates, in behavioral terms. Shown in reports. */
  description?: string;
  /** Target file this anchor applies to. Required when the graft has multiple targets. */
  file?: string;
  /** Identifiers or strings that identify the anchor; used to narrow diffs and find moved code. */
  symbols: string[];
  /** When several nodes match: 'error' (default, fail loudly) or 'first'. */
  ambiguity?: 'error' | 'first';
  /** Return every candidate node within `root`. */
  find(scope: AnchorScope, root: AstNode): AstNode[];
}

type AnchorOptions = Pick<AnchorDefinition, 'description' | 'file' | 'ambiguity'>;

const isNode = (v: unknown): v is AstNode =>
  !!v && typeof v === 'object' && typeof (v as AstNode).type === 'string' && typeof (v as AstNode).start === 'number';

/** Pre-order walk of every node under `root` (inclusive). Return false from `visit` to skip children. */
export function walk(root: AstNode, visit: (node: AstNode, parent: AstNode | null) => boolean | void): void {
  const stack: [AstNode, AstNode | null][] = [[root, null]];
  while (stack.length) {
    const [node, parent] = stack.pop()!;
    if (visit(node, parent) === false) continue;
    const children: AstNode[] = [];
    for (const key in node) {
      if (key === 'parent') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) children.push(item);
      } else if (isNode(value)) {
        children.push(value);
      }
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i]!, node]);
  }
}

/** Every node under `root` for which `predicate` holds, in source order. */
export function findAll(root: AstNode, predicate: (node: AstNode, parent: AstNode | null) => boolean): AstNode[] {
  const out: AstNode[] = [];
  walk(root, (node, parent) => {
    if (predicate(node, parent)) out.push(node);
  });
  return out;
}

const nameOf = (node: unknown): string | undefined => {
  if (!isNode(node)) return undefined;
  if (node.type === 'Identifier' || node.type === 'PrivateIdentifier') return node.name as string;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return undefined;
};

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const isFunction = (n: unknown): n is AstNode => isNode(n) && FUNCTION_TYPES.has(n.type);

/** Top-level binding named `local`: a function/class declaration or a variable initializer. */
function topLevelBinding(program: Program, local: string): AstNode | undefined {
  for (const stmt of program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' && isNode(stmt.declaration) ? stmt.declaration : stmt;
    if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && nameOf(decl.id) === local) return decl;
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations as AstNode[]) {
        if (nameOf(d.id) === local && isNode(d.init)) return d.init;
      }
    }
  }
  return undefined;
}

/** Resolve the node bound to export `name` (ESM `export` forms, including `export { a as name }`). */
export function resolveExport(program: Program, name: string): AstNode | undefined {
  for (const stmt of program.body) {
    if (stmt.type === 'ExportDefaultDeclaration' && name === 'default') {
      const d = stmt.declaration as AstNode;
      return d.type === 'Identifier' ? topLevelBinding(program, d.name as string) : d;
    }
    if (stmt.type !== 'ExportNamedDeclaration') continue;
    const decl = stmt.declaration;
    if (isNode(decl)) {
      if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && nameOf(decl.id) === name) return decl;
      if (decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations as AstNode[]) if (nameOf(d.id) === name && isNode(d.init)) return d.init;
      }
    }
    if (stmt.source) continue; // re-export from another module
    for (const spec of (stmt.specifiers as AstNode[] | undefined) ?? []) {
      if (nameOf(spec.exported) === name) {
        const local = nameOf(spec.local);
        return local ? topLevelBinding(program, local) : undefined;
      }
    }
  }
  return undefined;
}

/** Build a custom anchor. */
export function anchor(definition: AnchorDefinition): AnchorDefinition {
  return definition;
}

/** The function exported as `name` (declaration, `export const name = () => …`, or `export { local as name }`). */
export function exportedFunction(name: string, options: AnchorOptions = {}): AnchorDefinition {
  return {
    description: `exported function "${name}"`,
    ...options,
    symbols: [name],
    find: ({ program }) => {
      const node = resolveExport(program, name);
      return isFunction(node) ? [node] : [];
    },
  };
}

/** The class exported as `name`. */
export function exportedClass(name: string, options: AnchorOptions = {}): AnchorDefinition {
  return {
    description: `exported class "${name}"`,
    ...options,
    symbols: [name],
    find: ({ program }) => {
      const node = resolveExport(program, name);
      return node && (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') ? [node] : [];
    },
  };
}

/** Method `method` of the class exported as `className`. Returns the method's FunctionExpression. */
export function classMethod(className: string, method: string, options: AnchorOptions = {}): AnchorDefinition {
  return {
    description: `method "${method}" of exported class "${className}"`,
    ...options,
    symbols: [className, method],
    find: ({ program }) => {
      const cls = resolveExport(program, className);
      if (!cls || !isNode(cls.body)) return [];
      return ((cls.body.body as AstNode[]) ?? [])
        .filter((m) => m.type === 'MethodDefinition' && nameOf(m.key) === method && isFunction(m.value))
        .map((m) => m.value as AstNode);
    },
  };
}

/** Any function named `name`: declaration, named expression, or variable/property initializer. */
export function functionNamed(name: string, options: AnchorOptions = {}): AnchorDefinition {
  return {
    description: `function "${name}"`,
    ...options,
    symbols: [name],
    find: (_scope, root) => {
      const out: AstNode[] = [];
      walk(root, (node) => {
        if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && nameOf(node.id) === name) out.push(node);
        else if (node.type === 'VariableDeclarator' && nameOf(node.id) === name && isFunction(node.init)) out.push(node.init);
        else if ((node.type === 'Property' || node.type === 'MethodDefinition') && nameOf(node.key) === name && isFunction(node.value)) {
          out.push(node.value);
        }
      });
      return [...new Set(out)];
    },
  };
}

/** A call whose callee is `name` or `obj.name`. */
export function callTo(name: string, options: AnchorOptions = {}): AnchorDefinition {
  return {
    description: `call to "${name}"`,
    ...options,
    symbols: [name],
    find: (_scope, root) =>
      findAll(root, (node) => {
        if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return false;
        const callee = node.callee as AstNode;
        if (callee.type === 'Identifier') return callee.name === name;
        if (callee.type === 'MemberExpression') return nameOf(callee.property) === name;
        return false;
      }),
  };
}

/** A string literal (or untagged, expression-free template) with exactly `value`. */
export function stringLiteral(value: string, options: AnchorOptions = {}): AnchorDefinition {
  return {
    description: `string literal ${JSON.stringify(value)}`,
    ...options,
    symbols: [value],
    find: (_scope, root) =>
      findAll(root, (node) => {
        if (node.type === 'Literal') return node.value === value;
        if (node.type === 'TemplateLiteral') {
          const quasis = node.quasis as AstNode[];
          return quasis.length === 1 && (quasis[0]!.value as { cooked?: string }).cooked === value;
        }
        return false;
      }),
  };
}

/** An object property with key `key`. */
export function objectProperty(key: string, options: AnchorOptions = {}): AnchorDefinition {
  return {
    description: `object property "${key}"`,
    ...options,
    symbols: [key],
    find: (_scope, root) => findAll(root, (node) => node.type === 'Property' && nameOf(node.key) === key),
  };
}

/** Match `inner` only within the node located by `outer` (which must itself be unambiguous). */
export function within(outer: AnchorDefinition, inner: AnchorDefinition, options: AnchorOptions = {}): AnchorDefinition {
  return {
    description: `${inner.description ?? 'node'} within ${outer.description ?? 'node'}`,
    file: outer.file ?? inner.file,
    ambiguity: inner.ambiguity,
    ...options,
    symbols: [...outer.symbols, ...inner.symbols],
    find: (scope, root) => {
      const outers = outer.find(scope, root);
      if (outers.length !== 1 && !(outers.length > 1 && outer.ambiguity === 'first')) return [];
      return inner.find(scope, outers[0]!);
    },
  };
}
