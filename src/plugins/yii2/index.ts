import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walk, type Node } from '../../core/treesitter.js';
import type { EdgeRec, FileResult, FrameworkPlugin, GlobalContext, ParsedFile, SymbolRec } from '../../core/types.js';
import { resolveClass, stringValue, type PhpAst, type PhpClass } from '../php/index.js';

/**
 * Yii2 adds structure plain PHP parsing cannot see:
 *   - ActiveRecord relations: getOwner() { return $this->hasOne(User::class, ...) } -> relation Car::$owner
 *   - Components: Yii::$app->notifications -> the class configured under components in config/main.php
 *   - Queue dispatch: ->push(new SomeJob(...)) -> "dispatches" edge
 *   - Routes: FooBarController::actionView -> route:<app>/foo-bar/view
 *   - Access control: AuthItem constants referenced inside behaviors() -> "guarded_by" edge
 */

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const lcfirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const line = (n: Node) => n.startPosition.row + 1;
const isYiiApp = (n: Node | null) => !!n && /^\\?Yii::\$app$/.test(n.text);

const RELATION_METHODS = new Set(['hasone', 'hasmany']);
const CONFIG_FILE = /(^|\/)config\/(main|web|console)\.php$/;

function relations(cls: PhpClass, ast: PhpAst, out: FileResult): void {
  for (const unit of ast.units) {
    if (unit.cls !== cls) continue;
    const method = unit.fqn.split('::')[1];
    const m = /^get([A-Z]\w*)$/.exec(method);
    if (!m) continue;
    for (const body of unit.nodes) {
      walk(body, (n) => {
        if (n.type !== 'member_call_expression') return;
        const name = n.childForFieldName('name')?.text.toLowerCase() ?? '';
        if (!RELATION_METHODS.has(name)) return;
        const firstArg = n.childForFieldName('arguments')?.namedChildren[0]?.namedChildren[0];
        let target: string | null = null;
        if (firstArg?.type === 'class_constant_access_expression') target = resolveClass(firstArg.namedChildren[0].text, unit.scope, cls);
        else target = stringValue(firstArg)?.replace(/^\\/, '') ?? null;
        const prop = lcfirst(m[1]);
        const methodNode = body.parent ?? body;
        out.symbols.push({
          kind: 'relation', name: prop, fqn: `${cls.fqn}::$${prop}`, parent: cls.fqn,
          startLine: methodNode.startPosition.row + 1, endLine: methodNode.endPosition.row + 1,
          signature: `relation $${prop}: ${n.childForFieldName('name')!.text}(${target ?? '?'}) via ${method}()`,
          tags: ['virtual'],
        });
        if (target) out.edges.push({ from: `${cls.fqn}::$${prop}`, to: target, kind: 'relation', line: line(n) });
        return false;
      });
    }
  }
}

function routes(path: string, cls: PhpClass, out: FileResult): void {
  const short = cls.fqn.split('\\').pop()!;
  if (!short.endsWith('Controller') || !cls.parent) return;
  const app = path.split('/')[0];
  const modules = [...path.matchAll(/modules\/([^/]+)\//g)].map((m) => m[1]);
  const controller = kebab(short.slice(0, -'Controller'.length));
  const body = cls.node.childForFieldName('body');
  for (const m of body?.namedChildren ?? []) {
    if (m.type !== 'method_declaration') continue;
    const name = m.childForFieldName('name')?.text ?? '';
    const a = /^action([A-Z]\w*)$/.exec(name);
    if (!a) continue;
    const route = [app, ...modules, controller, kebab(a[1])].join('/');
    out.symbols.push({
      kind: 'route', name: route, fqn: `route:${route}`, parent: cls.fqn,
      startLine: m.startPosition.row + 1, endLine: m.startPosition.row + 1,
      signature: `route ${route} → ${name}()`, tags: ['virtual'],
    });
    out.edges.push({ from: `route:${route}`, to: `${cls.fqn}::${name}`, kind: 'handled_by', line: line(m) });
  }
}

function bodyEdges(ast: PhpAst, out: FileResult): void {
  for (const unit of ast.units) {
    const isBehaviors = unit.cls && unit.fqn.endsWith('::behaviors');
    for (const body of unit.nodes) {
      walk(body, (n) => {
        // Yii::$app->component
        if (n.type === 'member_access_expression' && isYiiApp(n.childForFieldName('object'))) {
          const name = n.childForFieldName('name');
          if (name?.type === 'name') out.edges.push({ from: unit.fqn, to: `component:${name.text}`, kind: 'uses_component', line: line(n), confidence: 0.9 });
        }
        // ->push(new Job(...)) on any queue
        if (n.type === 'member_call_expression' && n.childForFieldName('name')?.text === 'push') {
          const arg = n.childForFieldName('arguments')?.namedChildren[0]?.namedChildren[0];
          if (arg?.type === 'object_creation_expression') {
            const t = arg.namedChildren.find((c) => c.type === 'name' || c.type === 'qualified_name');
            const job = t && resolveClass(t.text, unit.scope, unit.cls);
            if (job) out.edges.push({ from: unit.fqn, to: job, kind: 'dispatches', line: line(n) });
          }
        }
        // 'roles' => [AuthItem::X] inside behaviors()
        if (isBehaviors && n.type === 'class_constant_access_expression') {
          const [scopeNode, member] = n.namedChildren;
          const target = scopeNode && resolveClass(scopeNode.text, unit.scope, unit.cls);
          if (target && /AuthItem$/.test(target) && member?.text !== 'class') {
            out.edges.push({ from: unit.cls!.fqn, to: `${target}::${member.text}`, kind: 'guarded_by', line: line(n) });
          }
        }
      });
    }
  }
}

/** Find `'components' => [...]` in a config file and map each id to its class. */
function components(path: string, ast: PhpAst): FileResult {
  const out: FileResult = { symbols: [], edges: [] };
  const app = path.split('/')[0];
  walk(ast.root, (n) => {
    if (n.type !== 'array_element_initializer') return;
    const [key, value] = n.namedChildren;
    if (stringValue(key) !== 'components' || !value) return;
    // 'components' => [...]  or  'components' => array_merge([...], [...])
    const arrays = value.type === 'array_creation_expression'
      ? [value]
      : (value.childForFieldName('arguments')?.namedChildren ?? [])
          .map((a) => a.namedChildren[0])
          .filter((a): a is Node => a?.type === 'array_creation_expression');
    for (const el of arrays.flatMap((a) => a.namedChildren)) {
      if (el.type !== 'array_element_initializer') continue;
      const [k, v] = el.namedChildren;
      const id = stringValue(k);
      if (!id || !v) continue;
      let classNode: Node | undefined = v;
      if (v.type === 'array_creation_expression') {
        classNode = v.namedChildren.find((c) => c.type === 'array_element_initializer' && stringValue(c.namedChildren[0]) === 'class')?.namedChildren[1];
      }
      let cls: string | null = null;
      if (classNode?.type === 'class_constant_access_expression') {
        const scope = ast.units.find((u) => u.nodes.some((x) => x.startIndex <= el.startIndex && x.endIndex >= el.endIndex))?.scope;
        cls = scope ? resolveClass(classNode.namedChildren[0].text, scope) : classNode.namedChildren[0].text;
      } else cls = stringValue(classNode)?.replace(/^\\/, '') ?? null;
      const fqn = `component:${id}`;
      out.symbols.push({
        kind: 'component', name: id, fqn, parent: null, file: path,
        startLine: el.startPosition.row + 1, endLine: el.endPosition.row + 1,
        signature: `component ${id} => ${cls ?? '(no class)'}  [${app}]`, tags: ['virtual', app],
      });
      if (cls) out.edges.push({ from: fqn, to: cls, kind: 'configured_as', line: el.startPosition.row + 1 });
    }
    return false;
  });
  return out;
}

export const yii2Plugin: FrameworkPlugin = {
  id: 'yii2',
  version: '2',
  dependsOn: ['php'],

  detect(root: string): boolean {
    const composer = join(root, 'composer.json');
    return existsSync(composer) && readFileSync(composer, 'utf8').includes('"yiisoft/yii2"');
  },

  enrichFile(path: string, _src: string, parsed: ParsedFile): FileResult {
    const ast = parsed.ast as PhpAst | undefined;
    const out: FileResult = { symbols: [], edges: [] };
    if (!ast) return out;
    for (const cls of ast.classes) {
      relations(cls, ast, out);
      routes(path, cls, out);
    }
    bodyEdges(ast, out);
    return out;
  },

  globalInputs: (path: string) => CONFIG_FILE.test(path),

  enrichGlobal(ctx: GlobalContext): FileResult {
    const symbols: SymbolRec[] = [];
    const edges: EdgeRec[] = [];
    for (const path of ctx.files().filter((f) => CONFIG_FILE.test(f))) {
      const parsed = ctx.parse(path);
      if (!parsed?.ast) continue;
      const r = components(path, parsed.ast as PhpAst);
      symbols.push(...r.symbols);
      edges.push(...r.edges);
    }
    return { symbols, edges };
  },
};

export default yii2Plugin;
