import type Parser from 'web-tree-sitter';
import { docSummary, loadGrammar, oneLine, walk, type Node } from '../../core/treesitter.js';
import type { EdgeRec, LanguagePlugin, ParsedFile, SymbolRec } from '../../core/types.js';

/** Name-resolution context: the namespace and `use` imports in effect at a point in the file. */
export interface PhpScope {
  ns: string;
  /** lower-case alias -> fqn (classes, functions and constants share one map; good enough). */
  aliases: Map<string, string>;
}

export interface PhpClass {
  fqn: string;
  kind: string;
  /** Resolved fqn of the `extends` target, if any. */
  parent?: string;
  node: Node;
  scope: PhpScope;
}

/** A body of executable code: a method, a function, or the file's top-level statements. */
export interface PhpUnit {
  /** fqn of the method/function, or the file path for top-level code. */
  fqn: string;
  cls?: PhpClass;
  nodes: Node[];
  scope: PhpScope;
}

export interface PhpAst {
  root: Node;
  src: string;
  classes: PhpClass[];
  units: PhpUnit[];
}

const CLASS_KINDS: Record<string, string> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  trait_declaration: 'trait',
  enum_declaration: 'enum',
};

const BUILTIN_TYPES = new Set([
  'int', 'float', 'string', 'bool', 'array', 'callable', 'iterable', 'object', 'mixed', 'void',
  'null', 'never', 'false', 'true', 'static', 'self', 'parent',
]);

/** Resolve a class name as written to an fqn using PHP's rules. Returns null for builtin types. */
export function resolveClass(name: string, scope: PhpScope, cls?: PhpClass): string | null {
  const t = name.trim();
  if (!t) return null;
  if (t.startsWith('\\')) return t.slice(1);
  const lower = t.toLowerCase();
  if (lower === 'self' || lower === 'static' || lower === '$this') return cls?.fqn ?? null;
  if (lower === 'parent') return cls?.parent ?? null;
  if (BUILTIN_TYPES.has(lower)) return null;
  if (lower.startsWith('namespace\\')) return join(scope.ns, t.slice(10));
  const [first, ...rest] = t.split('\\');
  const alias = scope.aliases.get(first.toLowerCase());
  if (alias) return [alias, ...rest].join('\\');
  return join(scope.ns, t);
}

const join = (ns: string, name: string) => (ns ? `${ns}\\${name}` : name);

/** Text of a string literal node without quotes; null when it is not a plain string. */
export function stringValue(n: Node | null | undefined): string | null {
  if (!n || (n.type !== 'string' && n.type !== 'encapsed_string')) return null;
  return n.text.replace(/^['"]|['"]$/g, '');
}

function precedingDoc(node: Node): string | undefined {
  let prev = node.previousNamedSibling;
  while (prev && prev.type === 'attribute_list') prev = prev.previousNamedSibling;
  if (prev?.type === 'comment' && prev.text.startsWith('/**') && node.startPosition.row - prev.endPosition.row <= 2) {
    return docSummary(prev.text);
  }
  return undefined;
}

/** Declaration text up to (not including) the body, without attributes. */
function header(node: Node, src: string): string {
  const body = node.childForFieldName('body');
  const first = node.children.find((c) => c.type !== 'attribute_list' && c.type !== 'comment') ?? node;
  return oneLine(src.slice(first.startIndex, body ? body.startIndex : node.endIndex).replace(/[;{]\s*$/, ''));
}

const lines = (n: Node) => ({ startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 });

class FileParser {
  symbols: SymbolRec[] = [];
  edges: EdgeRec[] = [];
  classes: PhpClass[] = [];
  units: PhpUnit[] = [];

  constructor(
    private readonly path: string,
    private readonly src: string,
  ) {}

  run(root: Node): void {
    this.statements(root.namedChildren, { ns: '', aliases: new Map() });
    for (const u of this.units) this.collectCalls(u);
  }

  /** Walk a statement list, tracking `namespace X;` and `use` statements as they appear. */
  private statements(nodes: Node[], scope: PhpScope): void {
    for (const n of nodes) {
      switch (n.type) {
        case 'namespace_definition': {
          const name = n.childForFieldName('name')?.text ?? '';
          const body = n.childForFieldName('body');
          if (body) this.statements(body.namedChildren, { ns: name, aliases: new Map() });
          else {
            scope = { ns: name, aliases: new Map() };
          }
          break;
        }
        case 'namespace_use_declaration':
          scope = { ns: scope.ns, aliases: new Map(scope.aliases) };
          this.useDecl(n, scope);
          break;
        case 'function_definition':
          this.fn(n, scope);
          break;
        case 'php_tag':
        case 'text':
        case 'comment':
          break;
        default:
          if (CLASS_KINDS[n.type]) this.classLike(n, scope);
          else this.units.push({ fqn: this.path, nodes: [n], scope });
      }
    }
  }

  private useDecl(n: Node, scope: PhpScope): void {
    const group = n.namedChildren.find((c) => c.type === 'namespace_name' || c.type === 'namespace_name_as_prefix');
    const groupPrefix = n.namedChildren.some((c) => c.type === 'namespace_use_group') ? group?.text ?? '' : '';
    walk(n, (c) => {
      if (c.type !== 'namespace_use_clause' && c.type !== 'namespace_use_group_clause') return;
      const target = c.namedChildren.find((x) => x.type === 'qualified_name' || x.type === 'name' || x.type === 'namespace_name');
      if (!target) return false;
      const alias = c.namedChildren.find((x) => x.type === 'namespace_aliasing_clause')?.namedChildren[0]?.text;
      const full = (groupPrefix ? `${groupPrefix.replace(/\\$/, '')}\\` : '') + target.text.replace(/^\\/, '');
      scope.aliases.set((alias ?? full.split('\\').pop()!).toLowerCase(), full);
      return false;
    });
  }

  private fn(n: Node, scope: PhpScope): void {
    const name = n.childForFieldName('name')?.text ?? '?';
    const fqn = join(scope.ns, name);
    this.symbols.push({ kind: 'function', name, fqn, parent: null, ...lines(n), signature: header(n, this.src), doc: precedingDoc(n) });
    const body = n.childForFieldName('body');
    if (body) this.units.push({ fqn, nodes: [body], scope });
  }

  private classLike(n: Node, scope: PhpScope): void {
    const kind = CLASS_KINDS[n.type];
    const name = n.childForFieldName('name')?.text ?? '?';
    const fqn = join(scope.ns, name);
    const base = n.namedChildren.find((c) => c.type === 'base_clause');
    const ifaces = n.namedChildren.find((c) => c.type === 'class_interface_clause');
    const names = (c?: Node) => (c?.namedChildren ?? []).filter((x) => x.type === 'name' || x.type === 'qualified_name');

    const cls: PhpClass = { fqn, kind, node: n, scope };
    const line = n.startPosition.row + 1;
    for (const b of names(base)) {
      const target = resolveClass(b.text, scope);
      if (!target) continue;
      // Interfaces "extend" interfaces; classes have one parent.
      if (kind === 'class') cls.parent = target;
      this.edges.push({ from: fqn, to: target, kind: 'extends', line });
    }
    for (const i of names(ifaces)) {
      const target = resolveClass(i.text, scope);
      if (target) this.edges.push({ from: fqn, to: target, kind: 'implements', line });
    }
    this.classes.push(cls);
    this.symbols.push({ kind, name, fqn, parent: null, ...lines(n), signature: header(n, this.src), doc: precedingDoc(n) });

    const body = n.childForFieldName('body');
    for (const m of body?.namedChildren ?? []) this.member(m, cls);
  }

  private member(m: Node, cls: PhpClass): void {
    const scope = cls.scope;
    switch (m.type) {
      case 'method_declaration': {
        const name = m.childForFieldName('name')?.text ?? '?';
        const fqn = `${cls.fqn}::${name}`;
        const tags = m.namedChildren
          .filter((c) => c.type.endsWith('_modifier'))
          .map((c) => c.text.toLowerCase());
        this.symbols.push({
          kind: 'method', name, fqn, parent: cls.fqn, ...lines(m),
          signature: header(m, this.src), doc: precedingDoc(m), tags,
        });
        const body = m.childForFieldName('body');
        if (body) this.units.push({ fqn, cls, nodes: [body], scope });
        this.promotedProperties(m, cls);
        break;
      }
      case 'property_declaration':
        for (const el of m.namedChildren.filter((c) => c.type === 'property_element')) {
          const name = el.namedChildren[0]?.text ?? '?';
          const mods = m.namedChildren.filter((c) => c !== el && c.type !== 'property_element').map((c) => c.text).join(' ');
          this.symbols.push({
            kind: 'property', name: name.replace(/^\$/, ''), fqn: `${cls.fqn}::${name}`, parent: cls.fqn, ...lines(m),
            signature: oneLine(`${mods} ${el.text}`, 160), doc: precedingDoc(m),
          });
        }
        break;
      case 'const_declaration':
        for (const el of m.namedChildren.filter((c) => c.type === 'const_element')) {
          const name = el.namedChildren[0]?.text ?? '?';
          this.symbols.push({
            kind: 'const', name, fqn: `${cls.fqn}::${name}`, parent: cls.fqn, ...lines(el),
            signature: oneLine(`const ${el.text}`, 120), doc: precedingDoc(m),
          });
        }
        break;
      case 'enum_case': {
        const name = m.childForFieldName('name')?.text ?? '?';
        this.symbols.push({
          kind: 'const', name, fqn: `${cls.fqn}::${name}`, parent: cls.fqn, ...lines(m), signature: oneLine(m.text, 120),
        });
        break;
      }
      case 'use_declaration':
        for (const t of m.namedChildren.filter((c) => c.type === 'name' || c.type === 'qualified_name')) {
          const target = resolveClass(t.text, scope, cls);
          if (target) this.edges.push({ from: cls.fqn, to: target, kind: 'uses_trait', line: m.startPosition.row + 1 });
        }
        break;
    }
  }

  /** PHP 8 constructor promotion: `public function __construct(private Foo $foo)`. */
  private promotedProperties(m: Node, cls: PhpClass): void {
    if (m.childForFieldName('name')?.text !== '__construct') return;
    for (const p of m.childForFieldName('parameters')?.namedChildren ?? []) {
      if (p.type !== 'property_promotion_parameter') continue;
      const v = p.childForFieldName('name')?.text ?? p.namedChildren.find((c) => c.type === 'variable_name')?.text;
      if (!v) continue;
      this.symbols.push({
        kind: 'property', name: v.replace(/^\$/, ''), fqn: `${cls.fqn}::${v}`, parent: cls.fqn, ...lines(p),
        signature: oneLine(p.text, 160),
      });
    }
  }

  private collectCalls(u: PhpUnit): void {
    const add = (to: string | null, kind: string, n: Node, confidence = 1) => {
      if (to) this.edges.push({ from: u.fqn, to, kind, line: n.startPosition.row + 1, confidence });
    };
    const cls = u.cls;
    for (const root of u.nodes) {
      walk(root, (n) => {
        switch (n.type) {
          case 'member_call_expression':
          case 'nullsafe_member_call_expression': {
            const name = n.childForFieldName('name');
            if (name?.type !== 'name') break;
            const obj = n.childForFieldName('object')?.text;
            if (obj === '$this' && cls) add(`${cls.fqn}::${name.text}`, 'calls', n, 0.9);
            else add(`*::${name.text}`, 'calls', n, 0.3);
            break;
          }
          case 'scoped_call_expression': {
            const name = n.childForFieldName('name');
            const scopeNode = n.childForFieldName('scope');
            if (name?.type !== 'name' || !scopeNode || scopeNode.type.startsWith('variable')) break;
            const target = resolveClass(scopeNode.text, u.scope, cls);
            if (target) add(`${target}::${name.text}`, 'calls', n);
            break;
          }
          case 'function_call_expression': {
            const fn = n.childForFieldName('function');
            if (!fn || (fn.type !== 'name' && fn.type !== 'qualified_name')) break;
            if (fn.type === 'qualified_name' || fn.text.startsWith('\\')) add(resolveClass(fn.text, u.scope), 'calls', n);
            else add(`~${fn.text}`, 'calls', n, 0.7);
            break;
          }
          case 'member_access_expression':
          case 'nullsafe_member_access_expression': {
            // $x->prop (not a call): needed to find users of magic properties such as framework relations.
            const name = n.childForFieldName('name');
            if (name?.type !== 'name' || n.parent?.type === 'member_call_expression') break;
            const obj = n.childForFieldName('object')?.text;
            if (obj === '$this' && cls) add(`${cls.fqn}::$${name.text}`, 'reads', n, 0.9);
            else add(`*::$${name.text}`, 'reads', n, 0.2);
            break;
          }
          case 'object_creation_expression': {
            const t = n.namedChildren.find((c) => c.type === 'name' || c.type === 'qualified_name');
            if (t) add(resolveClass(t.text, u.scope, cls), 'instantiates', n);
            break;
          }
          case 'class_constant_access_expression': {
            const [scopeNode, member] = n.namedChildren;
            if (!scopeNode || !member || scopeNode.type.startsWith('variable')) break;
            const target = resolveClass(scopeNode.text, u.scope, cls);
            if (!target) break;
            add(member.text === 'class' ? target : `${target}::${member.text}`, 'references', n);
            break;
          }
          case 'anonymous_function_creation_expression':
          case 'arrow_function':
            break; // Calls inside closures are attributed to the enclosing unit.
        }
      });
    }
  }
}

export class PhpPlugin implements LanguagePlugin<PhpAst> {
  readonly id = 'php';
  readonly version = '2';
  readonly extensions = ['.php'];
  private parser!: Parser;

  async init(): Promise<void> {
    this.parser = await loadGrammar('php');
  }

  parse(path: string, src: string): ParsedFile<PhpAst> {
    const tree = this.parser.parse(src);
    const p = new FileParser(path, src);
    p.run(tree.rootNode);
    return {
      symbols: p.symbols,
      edges: p.edges,
      ast: { root: tree.rootNode, src, classes: p.classes, units: p.units },
      dispose: () => tree.delete(),
    };
  }
}

export default new PhpPlugin();
