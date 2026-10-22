import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type Parser from 'web-tree-sitter';
import { docSummary, loadGrammar, oneLine, walk, type Node } from '../../core/treesitter.js';
import type { EdgeRec, LanguagePlugin, ParsedFile, SymbolRec } from '../../core/types.js';

/**
 * TypeScript / JavaScript (incl. JSX/TSX).
 *
 * fqn scheme: "<module>::<name>", "<module>::<Class>::<member>", where module is the repo-relative
 * path without extension and without a trailing "/index" (so "./ui" and "./ui/index.ts" agree).
 * A default export is "<module>::default"; its symbol keeps the real name for search.
 */

export interface TsUnit {
  /** fqn of the function/method/const, or the module id for top-level statements. */
  fqn: string;
  cls?: string;
  nodes: Node[];
}

export interface TsAst {
  root: Node;
  src: string;
  module: string;
  units: TsUnit[];
  /** exported name ("default" included) -> local fqn */
  exports: Map<string, string>;
  /** File-level directives: "use client", "use server", "use strict". */
  directives: string[];
  /** Resolve an identifier as written in this file to an fqn (imports, then local declarations). */
  resolve(name: string): string | null;
}

const EXT = /\.(d\.ts|tsx?|jsx?|mjs|cjs|mts|cts)$/;
export const moduleId = (path: string) => path.replace(EXT, '').replace(/\/index$/, '') || '.';

interface PathAlias { prefix: string; targets: string[] }

/**
 * tsconfig/jsconfig "paths" (e.g. "@/*": ["./src/*"]) from every config variant at the root,
 * resolved to repo-relative prefixes. `extra` ({"@hooks/": "src/hooks/"}) comes from .codeindex.json.
 */
function readAliases(root: string, extra: Record<string, string> = {}): PathAlias[] {
  const out: PathAlias[] = Object.entries(extra).map(([prefix, target]) => ({ prefix, targets: [target.replace(/^\.\//, '')] }));
  for (const name of ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json', 'jsconfig.json']) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    try {
      // tsconfig allows comments and trailing commas.
      const raw = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\/|(^|[^:"'])\/\/.*$/gm, '$1')
        .replace(/,(\s*[}\]])/g, '$1');
      const co = JSON.parse(raw).compilerOptions ?? {};
      const base = posix.normalize(co.baseUrl ?? '.');
      for (const [k, v] of Object.entries((co.paths ?? {}) as Record<string, string[]>)) {
        out.push({
          prefix: k.replace(/\*$/, ''),
          targets: v.map((t) => posix.normalize(posix.join(base, t.replace(/\*$/, ''))).replace(/^\.\/?/, '')),
        });
      }
    } catch {
      /* unreadable config: skip it */
    }
  }
  // Longest prefix first, so "@/components/" wins over "@/".
  return out.sort((a, b) => b.prefix.length - a.prefix.length);
}

const lines = (n: Node) => ({ startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 });
const isCapitalized = (s: string) => /^[A-Z]/.test(s);
const strValue = (n: Node | null | undefined) =>
  n && (n.type === 'string' || n.type === 'template_string') && !n.namedChildren.some((c) => c.type === 'template_substitution')
    ? n.text.slice(1, -1)
    : null;

function precedingDoc(node: Node): string | undefined {
  const target = node.parent?.type === 'export_statement' ? node.parent : node;
  const prev = target.previousNamedSibling;
  if (prev?.type === 'comment' && prev.text.startsWith('/**') && target.startPosition.row - prev.endPosition.row <= 1) {
    return docSummary(prev.text);
  }
  return undefined;
}

class FileParser {
  symbols: SymbolRec[] = [];
  edges: EdgeRec[] = [];
  units: TsUnit[] = [];
  exports = new Map<string, string>();
  directives: string[] = [];
  private imports = new Map<string, string>();
  private namespaces = new Map<string, string>();
  private locals = new Map<string, string>();
  readonly module: string;

  constructor(
    private readonly path: string,
    private readonly src: string,
    private readonly aliases: PathAlias[],
  ) {
    this.module = moduleId(path);
  }

  /** "./x", "@/lib/x" -> module id; bare packages -> null (external). */
  resolveModule(spec: string): string | null {
    if (spec.startsWith('.')) return moduleId(posix.normalize(posix.join(posix.dirname(this.path), spec)));
    for (const a of this.aliases) {
      if (a.prefix && spec.startsWith(a.prefix) && a.targets[0] !== undefined) {
        return moduleId(posix.join(a.targets[0], spec.slice(a.prefix.length)));
      }
    }
    return null;
  }

  resolve = (name: string): string | null => {
    const [head, ...rest] = name.split('.');
    if (rest.length && this.namespaces.has(head)) return `${this.namespaces.get(head)}::${rest.join('::')}`;
    const base = this.imports.get(head) ?? this.locals.get(head);
    if (!base) return null;
    return rest.length ? `${base}::${rest.join('::')}` : base;
  };

  run(root: Node): void {
    const stmts = root.namedChildren;
    for (const s of stmts) {
      const lit = s.type === 'expression_statement' ? strValue(s.namedChildren[0]) : null;
      if (lit && /^use [a-z]+$/.test(lit)) this.directives.push(lit);
      else if (s.type !== 'comment') break;
    }
    // Pass 1: imports and local names, so pass 2 can resolve forward references.
    for (const s of stmts) {
      if (s.type === 'import_statement') this.importDecl(s);
      const decl = s.type === 'export_statement' ? s.childForFieldName('declaration') : s;
      if (decl) for (const name of this.declNames(decl)) this.locals.set(name, `${this.module}::${name}`);
    }
    for (const s of stmts) this.statement(s);
    for (const u of this.units) this.collect(u);
  }

  private importDecl(s: Node): void {
    const mod = this.resolveModule(strValue(s.childForFieldName('source')) ?? '');
    if (!mod) return;
    const clause = s.namedChildren.find((c) => c.type === 'import_clause');
    for (const c of clause?.namedChildren ?? []) {
      if (c.type === 'identifier') this.imports.set(c.text, `${mod}::default`);
      else if (c.type === 'namespace_import') {
        const id = c.namedChildren.find((x) => x.type === 'identifier');
        if (id) this.namespaces.set(id.text, mod);
      } else if (c.type === 'named_imports') {
        for (const spec of c.namedChildren.filter((x) => x.type === 'import_specifier')) {
          const name = spec.childForFieldName('name')!.text;
          const alias = spec.childForFieldName('alias')?.text ?? name;
          this.imports.set(alias, `${mod}::${name}`);
        }
      }
    }
  }

  private declNames(d: Node): string[] {
    const name = d.childForFieldName('name')?.text;
    if (name && /declaration$/.test(d.type)) return [name];
    if (d.type === 'lexical_declaration' || d.type === 'variable_declaration') {
      return d.namedChildren
        .filter((c) => c.type === 'variable_declarator' && c.childForFieldName('name')?.type === 'identifier')
        .map((c) => c.childForFieldName('name')!.text);
    }
    return [];
  }

  private statement(s: Node): void {
    if (s.type === 'import_statement' || s.type === 'comment') return;
    if (s.type === 'export_statement') return this.exportStmt(s);
    if (!this.declaration(s, false)) this.units.push({ fqn: this.module, nodes: [s] });
  }

  private exportStmt(s: Node): void {
    const isDefault = s.children.some((c) => c.type === 'default');
    const decl = s.childForFieldName('declaration');
    const source = strValue(s.childForFieldName('source'));
    const line = s.startPosition.row + 1;

    if (decl) {
      this.declaration(decl, true, isDefault);
      return;
    }
    // export { a as b } [from './x']   /   export * from './x'
    const clause = s.namedChildren.find((c) => c.type === 'export_clause');
    if (clause) {
      const fromMod = source ? this.resolveModule(source) : undefined;
      if (source && !fromMod) return;
      for (const spec of clause.namedChildren.filter((c) => c.type === 'export_specifier')) {
        const name = spec.childForFieldName('name')!.text;
        const alias = spec.childForFieldName('alias')?.text ?? name;
        const target = fromMod ? `${fromMod}::${name}` : this.resolve(name);
        if (!target) continue;
        const fqn = `${this.module}::${alias}`;
        this.exports.set(alias, target);
        if (fqn === target) continue;
        this.symbols.push({ kind: 'export', name: alias, fqn, parent: null, ...lines(spec), signature: `export { ${name}${alias !== name ? ` as ${alias}` : ''} }${source ? ` from '${source}'` : ''}` });
        this.edges.push({ from: fqn, to: target, kind: 'alias_of', line });
      }
      return;
    }
    if (source) {
      const mod = this.resolveModule(source);
      if (mod) this.edges.push({ from: this.module, to: mod, kind: 're_exports_all', line });
      return;
    }
    // export default <expression>
    const value = s.childForFieldName('value') ?? s.namedChildren.find((c) => c.type !== 'comment');
    if (!isDefault || !value) return;
    const fqn = `${this.module}::default`;
    this.exports.set('default', fqn);
    const target = value.type === 'identifier' ? this.resolve(value.text) : null;
    if (target) {
      this.symbols.push({ kind: 'export', name: value.text, fqn, parent: null, ...lines(s), signature: `export default ${value.text}` });
      this.edges.push({ from: fqn, to: target, kind: 'alias_of', line });
    } else {
      this.symbols.push({ kind: 'const', name: 'default', fqn, parent: null, ...lines(s), signature: oneLine(`export default ${value.text}`, 120) });
      this.units.push({ fqn, nodes: [value] });
    }
  }

  /** Returns false when the node is not a declaration (caller treats it as top-level code). */
  private declaration(d: Node, exported: boolean, isDefault = false): boolean {
    const tags = [exported ? 'export' : '', isDefault ? 'default' : ''].filter(Boolean);
    const named = (name: string) => {
      const fqn = isDefault ? `${this.module}::default` : `${this.module}::${name}`;
      if (exported) this.exports.set(isDefault ? 'default' : name, fqn);
      if (isDefault) this.locals.set(name, fqn);
      return fqn;
    };
    switch (d.type) {
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'function_signature':
      case 'function_expression': {
        const name = d.childForFieldName('name')?.text ?? 'default';
        const fqn = named(name);
        const isComponent = isCapitalized(name) && /\.(t|j)sx$/.test(this.path);
        this.symbols.push({
          kind: isComponent ? 'component' : 'function', name, fqn, parent: null, ...lines(d),
          signature: this.header(d), doc: precedingDoc(d), tags,
        });
        const body = d.childForFieldName('body');
        if (body) this.units.push({ fqn, nodes: [body] });
        return true;
      }
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'class': {
        const name = d.childForFieldName('name')?.text ?? 'default';
        this.classDecl(d, name, named(name), tags);
        return true;
      }
      case 'interface_declaration':
      case 'type_alias_declaration':
      case 'enum_declaration': {
        const name = d.childForFieldName('name')!.text;
        const kind = d.type === 'interface_declaration' ? 'interface' : d.type === 'enum_declaration' ? 'enum' : 'type';
        const sig = kind === 'type' ? oneLine(d.text, 160) : this.header(d);
        this.symbols.push({ kind, name, fqn: named(name), parent: null, ...lines(d), signature: sig, doc: precedingDoc(d), tags });
        if (kind === 'interface') {
          for (const h of d.namedChildren.filter((c) => c.type === 'extends_type_clause')) {
            for (const t of h.namedChildren) this.edge(named(name), t.text, 'extends', t);
          }
        }
        return true;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const v of d.namedChildren.filter((c) => c.type === 'variable_declarator')) {
          const nameNode = v.childForFieldName('name');
          if (nameNode?.type !== 'identifier') continue;
          const name = nameNode.text;
          const fqn = named(name);
          const value = v.childForFieldName('value');
          const fn = value && (value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'function');
          const isComponent = fn && isCapitalized(name) && /\.(t|j)sx$/.test(this.path);
          this.symbols.push({
            kind: isComponent ? 'component' : fn ? 'function' : 'const', name, fqn, parent: null, ...lines(v),
            signature: fn ? this.header(value!, `${d.text.split(/\s/)[0]} ${name} = `) : oneLine(`${d.text.split(/\s/)[0]} ${v.text}`, 140),
            doc: precedingDoc(d), tags,
          });
          if (value) this.units.push({ fqn, nodes: [value] });
        }
        return true;
      }
      case 'ambient_declaration':
      case 'module':
      case 'internal_module':
        return true;
      default:
        return false;
    }
  }

  private classDecl(d: Node, name: string, fqn: string, tags: string[]): void {
    this.symbols.push({ kind: 'class', name, fqn, parent: null, ...lines(d), signature: this.header(d), doc: precedingDoc(d), tags });
    const heritage = d.namedChildren.find((c) => c.type === 'class_heritage');
    for (const h of heritage?.namedChildren ?? []) {
      const kind = h.type === 'extends_clause' ? 'extends' : 'implements';
      for (const t of h.namedChildren) if (t.type !== 'type_arguments') this.edge(fqn, t.text.replace(/<.*$/, ''), kind, t);
    }
    for (const m of d.childForFieldName('body')?.namedChildren ?? []) {
      const mName = m.childForFieldName('name')?.text;
      if (!mName) continue;
      const mFqn = `${fqn}::${mName}`;
      if (m.type === 'method_definition' || m.type === 'method_signature' || m.type === 'abstract_method_signature') {
        this.symbols.push({ kind: 'method', name: mName, fqn: mFqn, parent: fqn, ...lines(m), signature: this.header(m), doc: precedingDoc(m) });
        const body = m.childForFieldName('body');
        if (body) this.units.push({ fqn: mFqn, cls: fqn, nodes: [body] });
      } else if (m.type === 'public_field_definition' || m.type === 'field_definition') {
        const value = m.childForFieldName('value');
        const fn = value?.type === 'arrow_function';
        this.symbols.push({
          kind: fn ? 'method' : 'property', name: mName, fqn: mFqn, parent: fqn, ...lines(m),
          signature: fn ? this.header(value!, oneLine(m.text.slice(0, value!.startIndex - m.startIndex))) : oneLine(m.text, 140),
        });
        if (value) this.units.push({ fqn: mFqn, cls: fqn, nodes: [value] });
      }
    }
  }

  /** Declaration text up to its body. For arrow functions, `prefix` is prepended. */
  private header(n: Node, prefix = ''): string {
    const body = n.childForFieldName('body');
    const end = body ? body.startIndex : n.endIndex;
    return oneLine(prefix + this.src.slice(n.startIndex, end).replace(/(=>|\{)\s*$/, (m) => (m.startsWith('=') ? '=>' : '')), 300);
  }

  private edge(from: string, name: string, kind: string, n: Node, confidence = 1): void {
    const to = this.resolve(name);
    if (to) this.edges.push({ from, to, kind, line: n.startPosition.row + 1, confidence });
  }

  private collect(u: TsUnit): void {
    const seen = new Set<string>();
    const add = (to: string | null, kind: string, n: Node, confidence = 1) => {
      if (!to) return;
      const key = `${to}|${kind}`;
      if (seen.has(key)) return; // one edge per target per unit keeps big components small
      seen.add(key);
      this.edges.push({ from: u.fqn, to, kind, line: n.startPosition.row + 1, confidence });
    };
    for (const root of u.nodes) {
      walk(root, (n) => {
        switch (n.type) {
          case 'call_expression': {
            const fn = n.childForFieldName('function');
            if (!fn) break;
            if (fn.type === 'identifier') add(this.resolve(fn.text), 'calls', n);
            else if (fn.type === 'member_expression') {
              const obj = fn.childForFieldName('object');
              const prop = fn.childForFieldName('property')?.text;
              if (!obj || !prop) break;
              if (obj.type === 'this' && u.cls) add(`${u.cls}::${prop}`, 'calls', n, 0.9);
              else if (obj.type === 'identifier') add(this.resolve(`${obj.text}.${prop}`), 'calls', n, 0.8);
            }
            break;
          }
          case 'new_expression': {
            const c = n.childForFieldName('constructor');
            if (c) add(this.resolve(c.text), 'instantiates', n);
            break;
          }
          case 'jsx_opening_element':
          case 'jsx_self_closing_element': {
            const name = n.childForFieldName('name')?.text;
            if (name && (isCapitalized(name) || name.includes('.'))) add(this.resolve(name), 'renders', n);
            break;
          }
          case 'type_identifier':
            add(this.resolve(n.text), 'references', n, 0.9);
            break;
          case 'identifier': {
            // Bare references to imported values (callbacks, HOC arguments) that are not calls.
            const p = n.parent?.type;
            if (p !== 'call_expression' && p !== 'jsx_opening_element' && p !== 'jsx_self_closing_element' && this.imports.has(n.text)) {
              add(this.resolve(n.text), 'references', n, 0.9);
            }
            break;
          }
        }
      });
    }
  }
}

export class TypeScriptPlugin implements LanguagePlugin<TsAst> {
  readonly id = 'typescript';
  readonly version = '2';
  readonly extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
  private ts!: Parser;
  private tsx!: Parser;
  private aliases: PathAlias[] = [];

  async init(root: string, options: { aliases?: Record<string, string> } = {}): Promise<void> {
    this.ts = await loadGrammar('typescript');
    this.tsx = await loadGrammar('tsx');
    this.aliases = readAliases(root, options.aliases);
  }

  /** Aliases in effect (for `code-index init` to show). */
  get pathAliases(): { prefix: string; targets: string[] }[] {
    return this.aliases;
  }

  parse(path: string, src: string): ParsedFile<TsAst> {
    if (path.endsWith('.d.ts') || /\.min\.js$/.test(path)) return { symbols: [], edges: [] };
    // The TSX grammar also parses plain JS (with JSX); only .ts-family files need the TS grammar (for <T>x casts).
    const parser = /\.(ts|mts|cts)$/.test(path) ? this.ts : this.tsx;
    const tree = parser.parse(src);
    const p = new FileParser(path, src, this.aliases);
    p.run(tree.rootNode);
    return {
      symbols: p.symbols,
      edges: p.edges,
      ast: {
        root: tree.rootNode, src, module: p.module, units: p.units, exports: p.exports,
        directives: p.directives, resolve: p.resolve,
      },
      dispose: () => tree.delete(),
    };
  }
}

export default new TypeScriptPlugin();

