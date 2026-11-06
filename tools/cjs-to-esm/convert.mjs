// Convert a CommonJS package's .js files to native ES modules.
//
// Used to author the `*-esm` graft variants. The output keeps CommonJS semantics where they
// matter to consumers:
//   - top-level `const x = require('./rel')` becomes a live `import` binding, so require
//     cycles that only touch each other inside functions (e.g. semver's Range <-> Comparator)
//     still work;
//   - a require that sits in a cycle *after* `module.exports = …` (the CommonJS
//     export-then-require idiom, e.g. pacote's Fetcher base requiring its subclasses) becomes a
//     lazy, on-demand require() of the converted ESM module, because ESM would otherwise
//     evaluate the subclasses before the base class exists;
//   - requires of other packages (and builtins) stay `require()` calls, through
//     `createRequire(import.meta.url)`: same entry point, same instance, and same laziness as
//     before, so a dual package (e.g. minipass) is never loaded twice (no dual-package hazard);
//   - `module` / `exports` are shimmed, so every `module.exports = …` / `exports.x = …` form works;
//   - the final `module.exports` value is exported as `default`, as each statically known key
//     (named exports), and as `'module.exports'`, so `require()` of the converted file from
//     CommonJS (Node's require(esm)) still returns exactly the old value.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';

const IDENT = /^[A-Za-z_$][\w$]*$/;

function walk(node, visit, parent = null, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent, ancestors);
  const next = [...ancestors, node];
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'type') continue;
    const value = node[key];
    if (Array.isArray(value)) for (const v of value) walk(v, visit, node, next);
    else if (value && typeof value.type === 'string') walk(value, visit, node, next);
  }
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** Relative require edges of a file: target path, and whether it comes after `module.exports =`. */
export function requireEdges(file, code) {
  const ast = parseCjs(code, file);
  const firstExport = ast.body.find(
    (s) => s.type === 'ExpressionStatement' && s.expression.type === 'AssignmentExpression' && isExportsRef(s.expression.left),
  );
  const edges = [];
  for (const stmt of ast.body) {
    const d = stmt.type === 'VariableDeclaration' && stmt.declarations.length === 1 ? stmt.declarations[0] : undefined;
    if (!d || !isRequireCall(d.init) || !d.init.arguments[0].value.startsWith('.')) continue;
    const target = resolveRelative(file, d.init.arguments[0].value);
    if (target) edges.push({ spec: d.init.arguments[0].value, target, afterExports: !!firstExport && stmt.start > firstExport.start });
  }
  return edges;
}

/** For each file, the require specifiers that must become lazy (cyclic export-then-require edges). */
export function lazyEdges(graph) {
  const reaches = (from, to, seen = new Set()) => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (graph.get(from) ?? []).some((e) => reaches(e.target, to, seen));
  };
  const lazy = new Map();
  for (const [file, edges] of graph) {
    const specs = new Set(edges.filter((e) => e.afterExports && reaches(e.target, file)).map((e) => e.spec));
    if (specs.size) lazy.set(file, specs);
  }
  return lazy;
}

const isRequireCall = (n) =>
  n?.type === 'CallExpression' &&
  n.callee.type === 'Identifier' &&
  n.callee.name === 'require' &&
  n.arguments.length === 1 &&
  n.arguments[0].type === 'Literal' &&
  typeof n.arguments[0].value === 'string';

const isModuleExports = (n) =>
  n?.type === 'MemberExpression' &&
  !n.computed &&
  n.object.type === 'Identifier' &&
  n.object.name === 'module' &&
  n.property.name === 'exports';

const isExportsRef = (n) => isModuleExports(n) || (n?.type === 'Identifier' && n.name === 'exports');

const propName = (p) => {
  if (p.computed) return p.property?.type === 'Literal' ? String(p.property.value) : undefined;
  return p.property?.name;
};

const keyName = (k, computed) =>
  computed
    ? k.type === 'Literal'
      ? String(k.value)
      : undefined
    : k.type === 'Identifier'
      ? k.name
      : k.type === 'Literal'
        ? String(k.value)
        : undefined;

export function parseCjs(code, file) {
  try {
    return parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
  } catch (err) {
    throw new Error(`${file}: ${err.message}`, { cause: err });
  }
}

/** Resolve a relative require from `fromFile` (absolute) the way Node's CJS resolver would. */
export function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const isFile = (p) => existsSync(p) && statSync(p).isFile();
  for (const candidate of [base, `${base}.js`, `${base}.json`]) if (isFile(candidate)) return candidate;
  if (existsSync(base) && statSync(base).isDirectory()) {
    const pj = path.join(base, 'package.json');
    if (isFile(pj)) {
      const main = JSON.parse(readFileSync(pj, 'utf8')).main;
      if (main) {
        const resolved = resolveRelative(path.join(base, 'index.js'), `./${main}`);
        if (resolved) return resolved;
      }
    }
    if (isFile(path.join(base, 'index.js'))) return path.join(base, 'index.js');
  }
  return undefined;
}

const toSpecifier = (fromFile, target) => {
  let rel = path.relative(path.dirname(fromFile), target).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
};

/** Statically determine the keys of a CommonJS module's exports. */
export function exportKeys(file, cache = new Map(), seen = new Set()) {
  if (cache.has(file)) return cache.get(file);
  if (seen.has(file) || !file.endsWith('.js')) return new Set();
  seen.add(file);
  const ast = parseCjs(readFileSync(file, 'utf8'), file);
  const keys = new Set();
  const fromAssignment = (expr) => {
    if (expr?.type !== 'AssignmentExpression' || expr.operator !== '=') return;
    const { left, right } = expr;
    if (isExportsRef(left)) {
      if (right.type === 'ObjectExpression') {
        for (const p of right.properties) {
          if (p.type !== 'Property') continue;
          const k = keyName(p.key, p.computed);
          if (k !== undefined) keys.add(k);
        }
      } else if (isRequireCall(right) && right.arguments[0].value.startsWith('.')) {
        const target = resolveRelative(file, right.arguments[0].value);
        if (target) for (const k of exportKeys(target, cache, seen)) keys.add(k);
      } else {
        fromAssignment(right); // exports = module.exports = {…}
      }
    } else if (left.type === 'MemberExpression' && isExportsRef(left.object)) {
      const k = propName(left);
      if (k !== undefined) keys.add(k);
    }
  };
  // `exports.x = …` may appear anywhere, e.g. `const re = exports.re = []` (semver internal/re.js).
  walk(ast, (n) => {
    if (n.type === 'AssignmentExpression') fromAssignment(n);
  });
  for (const stmt of ast.body) {
    if (stmt.type !== 'ExpressionStatement') continue;
    const e = stmt.expression;
    if (
      e.type === 'CallExpression' &&
      e.callee.type === 'MemberExpression' &&
      e.callee.object.name === 'Object' &&
      e.callee.property.name === 'defineProperty' &&
      isExportsRef(e.arguments[0]) &&
      e.arguments[1]?.type === 'Literal'
    ) {
      keys.add(String(e.arguments[1].value));
    }
  }
  keys.delete('__esModule');
  keys.delete('default');
  keys.delete('module.exports');
  cache.set(file, keys);
  return keys;
}

/**
 * Convert one CommonJS file (absolute path `file`, inside a package) to ESM source.
 * Throws on patterns it cannot convert faithfully, rather than guessing.
 */
export function convertFile(file, code, { keyCache = new Map(), lazy = new Set() } = {}) {
  const ast = parseCjs(code, file);
  const edits = []; // { start, end, text }
  const imports = [];
  const reqIds = new Map(); // spec -> identifier
  const problems = [];

  const isRelative = (spec) => spec.startsWith('.');
  let usesBareRequire = false;
  const resolveSpec = (spec) => {
    const target = resolveRelative(file, spec);
    if (!target) {
      problems.push(`cannot resolve require('${spec}')`);
      return { spec, json: false };
    }
    return { spec: toSpecifier(file, target), json: target.endsWith('.json'), target };
  };
  const importLine = (what, r) => `import ${what} from '${r.spec}'${r.json ? " with { type: 'json' }" : ''}`;
  const reqId = (raw) => {
    if (!reqIds.has(raw)) {
      const id = `__graft_req${reqIds.size}`;
      reqIds.set(raw, id);
      imports.push(importLine(id, resolveSpec(raw)));
    }
    return reqIds.get(raw);
  };

  // 1. Top-level `const x = require(…)` / `const { a, b: c } = require('./rel')` become imports.
  const hoisted = new Set();
  const lazyBindings = [];
  const reassigned = new Set();
  walk(ast, (n) => {
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') reassigned.add(n.left.name);
    if (n.type === 'UpdateExpression' && n.argument.type === 'Identifier') reassigned.add(n.argument.name);
  });
  for (const stmt of ast.body) {
    if (stmt.type !== 'VariableDeclaration' || stmt.declarations.length !== 1) continue;
    const [d] = stmt.declarations;
    if (!isRequireCall(d.init) || !isRelative(d.init.arguments[0].value)) continue;
    const raw = d.init.arguments[0].value;
    const r = resolveSpec(raw);
    if (lazy.has(raw)) {
      if (d.id.type !== 'Identifier') {
        problems.push(`cyclic require('${raw}') must be bound to a plain identifier to be made lazy`);
        continue;
      }
      lazyBindings.push({ name: d.id.name, spec: r.spec, decl: d.id });
      hoisted.add(d.init);
      edits.push({ start: stmt.start, end: stmt.end, text: '' });
      continue;
    }
    if (d.id.type === 'Identifier' && !reassigned.has(d.id.name)) {
      imports.push(importLine(d.id.name, r));
    } else if (
      d.id.type === 'ObjectPattern' &&
      r.target &&
      !r.json &&
      d.id.properties.every((p) => p.type === 'Property' && !p.computed && p.key.type === 'Identifier' && p.value.type === 'Identifier')
    ) {
      const keys = exportKeys(r.target, keyCache);
      if (!d.id.properties.every((p) => keys.has(p.key.name))) continue;
      const names = d.id.properties.map((p) => (p.key.name === p.value.name ? p.key.name : `${p.key.name} as ${p.value.name}`));
      imports.push(`import { ${names.join(', ')} } from '${r.spec}'`);
    } else {
      continue;
    }
    hoisted.add(d.init);
    edits.push({ start: stmt.start, end: stmt.end, text: '' });
  }

  // 1b. References to lazy bindings become calls to an on-demand getter. Only references inside
  //     functions (evaluated after loading) can be deferred; anything else cannot be faithful.
  lazyBindings.forEach((b, i) => {
    const getter = `(__graft_lazy${i}())`; // parenthesized: `new X(…)` must construct the value
    let declarations = 0;
    walk(ast, (n, parent, ancestors) => {
      if (n.type !== 'Identifier' || n.name !== b.name) return;
      if (n === b.decl) return;
      const isDecl =
        (parent?.type === 'VariableDeclarator' && parent.id === n) ||
        (FUNCTION_TYPES.has(parent?.type) && (parent.id === n || parent.params.includes(n))) ||
        (parent?.type === 'ClassDeclaration' && parent.id === n) ||
        (parent?.type === 'CatchClause' && parent.param === n);
      if (isDecl) {
        declarations++;
        return;
      }
      if (parent?.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
      if (
        (parent?.type === 'Property' || parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') &&
        parent.key === n &&
        !parent.computed &&
        !parent.shorthand
      )
        return;
      if (!ancestors.some((a) => FUNCTION_TYPES.has(a.type))) {
        problems.push(`cyclic binding ${b.name} (require('${b.spec}')) is used while the module loads; cannot defer it`);
        return;
      }
      if (parent?.type === 'Property' && parent.shorthand) {
        if (parent.value === n) edits.push({ start: n.start, end: n.end, text: `${b.name}: ${getter}` });
        return;
      }
      edits.push({ start: n.start, end: n.end, text: getter });
    });
    if (declarations) problems.push(`cyclic binding ${b.name} is shadowed; cannot rewrite it safely`);
  });
  if (lazyBindings.length) usesBareRequire = true;

  // 2. Remaining require() calls, require.main, __dirname/__filename.
  let usesMain = false;
  walk(ast, (n, parent) => {
    if (isRequireCall(n)) {
      if (!isRelative(n.arguments[0].value)) {
        usesBareRequire = true; // left as require(), served by createRequire
        return;
      }
      if (!hoisted.has(n)) edits.push({ start: n.start, end: n.end, text: reqId(n.arguments[0].value) });
      return;
    }
    if (n.type === 'MemberExpression' && n.object.type === 'Identifier' && n.object.name === 'require') {
      if (!n.computed && n.property.name === 'main') {
        usesMain = true;
        edits.push({ start: n.start, end: n.end, text: '__graft_main' });
      } else {
        problems.push(`unsupported require.${n.property.name ?? '[computed]'}`);
      }
      return;
    }
    if (n.type === 'Identifier' && (n.name === '__dirname' || n.name === '__filename')) {
      const isKey =
        (parent?.type === 'MemberExpression' && parent.property === n && !parent.computed) ||
        (parent?.type === 'Property' && parent.key === n && !parent.computed);
      if (!isKey) edits.push({ start: n.start, end: n.end, text: n.name === '__dirname' ? 'import.meta.dirname' : 'import.meta.filename' });
      return;
    }
    if (
      n.type === 'Identifier' &&
      n.name === 'require' &&
      !(parent?.type === 'CallExpression' && parent.callee === n) &&
      !(parent?.type === 'MemberExpression' && parent.object === n) &&
      !(parent?.type === 'MemberExpression' && parent.property === n && !parent.computed)
    ) {
      problems.push('`require` is used as a value');
    }
  });
  if (problems.length) throw new Error(`${file}:\n  - ${[...new Set(problems)].join('\n  - ')}`);

  // 3. Assemble: imports, module/exports shim, original body, exports.
  edits.sort((a, b) => b.start - a.start);
  let body = code;
  for (const e of edits) body = body.slice(0, e.start) + e.text + body.slice(e.end);
  let hashbang = '';
  if (body.startsWith('#!')) {
    const nl = body.indexOf('\n');
    hashbang = body.slice(0, nl + 1);
    body = body.slice(nl + 1);
  }
  const header = [
    '// Converted to ESM by graft (tools/cjs-to-esm).',
    ...(usesMain ? ["import { realpathSync as __graft_realpathSync } from 'node:fs'"] : []),
    ...(usesBareRequire ? ["import { createRequire as __graft_createRequire } from 'node:module'"] : []),
    ...imports,
    ...(usesBareRequire ? ['const require = __graft_createRequire(import.meta.url)'] : []),
    ...lazyBindings.map(
      (b, i) => `let __graft_lazy${i}_value; const __graft_lazy${i} = () => (__graft_lazy${i}_value ??= require('${b.spec}'))`,
    ),
    'const module = { exports: {} }',
    'let exports = module.exports',
    ...(usesMain
      ? [
          'const __graft_main = process.argv[1] !== undefined && __graft_realpathSync(process.argv[1]) === import.meta.filename ? module : undefined',
        ]
      : []),
    '',
  ].join('\n');
  const keys = [...exportKeys(file, keyCache)];
  const locals = keys.map((_, i) => `__graft_e${i}`);
  const footer = [
    '',
    ';const __graft_exports = module.exports',
    'export default __graft_exports',
    "export { __graft_exports as 'module.exports' }",
    ...(keys.length
      ? [
          `const { ${keys.map((k, i) => `${IDENT.test(k) ? k : JSON.stringify(k)}: ${locals[i]}`).join(', ')} } = __graft_exports`,
          `export { ${keys.map((k, i) => `${locals[i]} as ${IDENT.test(k) ? k : JSON.stringify(k)}`).join(', ')} }`,
        ]
      : []),
    '',
  ].join('\n');
  return `${hashbang}${header}${body.replace(/\s*$/, '\n')}${footer}`;
}
