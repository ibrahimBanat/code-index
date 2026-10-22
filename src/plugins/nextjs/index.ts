import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { oneLine, walk, type Node } from '../../core/treesitter.js';
import type { FileResult, FrameworkPlugin, ParsedFile } from '../../core/types.js';
import type { TsAst } from '../typescript/index.js';

/**
 * Next.js adds what the file system and conventions encode:
 *   - App Router: app/**\/page|layout|loading|error|not-found|template|default -> route symbols
 *   - Route handlers: app/**\/route.ts exporting GET/POST/... -> api_route symbols, one handled_by edge per verb
 *   - Pages Router: pages/** and pages/api/**
 *   - middleware.ts (with its matcher)
 *   - 'use client' components and 'use server' actions (file-level or inline)
 *   - fetch('/api/..'), <Link href>, redirect(), router.push() -> fetches / links_to edges to routes
 *
 * Route fqns normalise every dynamic segment to [*] so `fetch(`/api/users/${id}`)` joins
 * `app/api/users/[id]/route.ts`. Signatures keep the real segment names.
 */

const APP = /^(?:(.*)\/)?app\/((?:.*\/)?)(page|layout|loading|error|not-found|template|default|route)\.(?:tsx?|jsx?|mdx)$/;
const PAGES = /^(?:(.*)\/)?pages\/(.*)\.(?:tsx?|jsx?|mdx)$/;
const MIDDLEWARE = /^(?:src\/)?(middleware|instrumentation)\.(?:t|j)s$/;
const HTTP_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const ROUTE_CONFIG = [
  'generateMetadata', 'metadata', 'generateStaticParams', 'revalidate', 'dynamic', 'runtime',
  'fetchCache', 'preferredRegion', 'maxDuration', 'getServerSideProps', 'getStaticProps', 'getStaticPaths',
];
const NAVIGATION_CALLS = new Set(['redirect', 'permanentRedirect', 'push', 'replace', 'prefetch']);

/** Strip route groups "(x)", parallel slots "@x" and interception markers; return [display, normalised]. */
function routePath(segments: string[]): [string, string] {
  const kept = segments.filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@')).map((s) => s.replace(/^\(\.+\)/, ''));
  const display = '/' + kept.join('/');
  const norm = '/' + kept.map((s) => (/^\[.*\]$/.test(s) ? '[*]' : s)).join('/');
  return [display, norm];
}

/** "/api/users/${id}?x=1" -> "/api/users/[*]". Null when it is not an app-internal path. */
function urlToRoute(n: Node | null | undefined): string | null {
  if (!n) return null;
  let text: string;
  if (n.type === 'string') text = n.text.slice(1, -1);
  else if (n.type === 'template_string') {
    text = n.namedChildren.reduce((acc, c) => acc.replace(c.text, c.type === 'template_substitution' ? '[*]' : c.text), n.text.slice(1, -1));
  } else return null;
  if (!text.startsWith('/') || text.startsWith('//')) return null;
  const path = text.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  return path.split('/').map((s) => (s.includes('[*]') ? '[*]' : s)).join('/');
}

function isServerActionBody(root: Node): boolean {
  const body = root.type === 'statement_block' ? root : root.childForFieldName('body');
  const first = body?.type === 'statement_block' ? body.namedChildren[0] : undefined;
  return first?.type === 'expression_statement' && /^['"]use server['"]$/.test(first.namedChildren[0]?.text ?? '');
}

export const nextjsPlugin: FrameworkPlugin = {
  id: 'nextjs',
  version: '1',
  dependsOn: ['typescript'],

  detect(root: string): boolean {
    const pkg = join(root, 'package.json');
    if (!existsSync(pkg)) return false;
    const json = JSON.parse(readFileSync(pkg, 'utf8'));
    return !!(json.dependencies?.next ?? json.devDependencies?.next);
  },

  enrichFile(path: string, _src: string, parsed: ParsedFile): FileResult {
    const ast = parsed.ast as TsAst | undefined;
    const out: FileResult = { symbols: [], edges: [] };
    if (!ast) return out;
    const exported = [...ast.exports.keys()];
    const client = ast.directives.includes('use client');
    const fileServer = ast.directives.includes('use server');
    const config = exported.filter((e) => ROUTE_CONFIG.includes(e));
    const flags = [client ? 'client' : 'server', ...config].join(', ');
    const lineOf = (fqn: string) => parsed.symbols.find((s) => s.fqn === fqn)?.startLine ?? 1;

    const app = APP.exec(path);
    const pages = !app && PAGES.exec(path);
    const mw = MIDDLEWARE.exec(path);

    if (app) {
      const kind = app[3];
      const [display, norm] = routePath(app[2].split('/'));
      if (kind === 'route') {
        const verbs = exported.filter((e) => HTTP_VERBS.includes(e));
        out.symbols.push({
          kind: 'api_route', name: display, fqn: `route:${norm}`, parent: null, startLine: 1, endLine: 1,
          signature: `api ${verbs.join('|') || '?'} ${display}${config.length ? `  [${config.join(', ')}]` : ''}`, tags: ['virtual'],
        });
        for (const v of verbs) out.edges.push({ from: `route:${norm}`, to: ast.exports.get(v)!, kind: 'handled_by', line: lineOf(ast.exports.get(v)!) });
      } else {
        const fqn = kind === 'page' ? `route:${norm}` : `${kind}:${norm}`;
        out.symbols.push({
          kind: kind === 'page' ? 'page' : kind.replace('-', '_'), name: display, fqn, parent: null, startLine: 1, endLine: 1,
          signature: `${kind} ${display}  [${flags}]`, tags: ['virtual'],
        });
        const handler = ast.exports.get('default');
        if (handler) out.edges.push({ from: fqn, to: handler, kind: 'handled_by', line: lineOf(handler) });
      }
    } else if (pages && !/(^|\/)_(app|document|error)$/.test(pages[2])) {
      const segs = pages[2].split('/');
      if (segs[segs.length - 1] === 'index') segs.pop();
      const [display, norm] = routePath(segs);
      const api = segs[0] === 'api';
      out.symbols.push({
        kind: api ? 'api_route' : 'page', name: display, fqn: `route:${norm}`, parent: null, startLine: 1, endLine: 1,
        signature: `${api ? 'api' : 'page'} ${display}  [pages router${config.length ? ', ' + config.join(', ') : ''}]`, tags: ['virtual'],
      });
      const handler = ast.exports.get('default');
      if (handler) out.edges.push({ from: `route:${norm}`, to: handler, kind: 'handled_by', line: lineOf(handler) });
    } else if (mw) {
      const matcher = /matcher\s*:\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/.exec(ast.src)?.[1];
      out.symbols.push({
        kind: mw[1], name: mw[1], fqn: `${mw[1]}:`, parent: null, startLine: 1, endLine: 1,
        signature: `${mw[1]}${matcher ? `  matcher ${oneLine(matcher, 120)}` : ''}`, tags: ['virtual'],
      });
      const handler = ast.exports.get('middleware') ?? ast.exports.get('default') ?? ast.exports.get('register');
      if (handler) out.edges.push({ from: `${mw[1]}:`, to: handler, kind: 'handled_by', line: lineOf(handler) });
    }

    // Client components / server actions, shown as a suffix on the declaration line.
    for (const s of parsed.symbols) {
      if (s.parent || !(s.tags ?? []).includes('export')) continue;
      if (client && s.kind === 'component') {
        out.symbols.push({ kind: 'client_component', name: s.name, fqn: `${s.fqn}#client`, parent: null, startLine: s.startLine, endLine: s.startLine, signature: 'client component', tags: ['virtual'] });
      }
      if (fileServer && (s.kind === 'function' || s.kind === 'const')) {
        out.symbols.push({ kind: 'server_action', name: s.name, fqn: `${s.fqn}#action`, parent: null, startLine: s.startLine, endLine: s.startLine, signature: 'server action', tags: ['virtual'] });
      }
    }

    for (const unit of ast.units) {
      for (const root of unit.nodes) {
        if (!fileServer && isServerActionBody(root)) {
          const s = parsed.symbols.find((x) => x.fqn === unit.fqn);
          if (s) out.symbols.push({ kind: 'server_action', name: s.name, fqn: `${s.fqn}#action`, parent: s.parent ?? null, startLine: s.startLine, endLine: s.startLine, signature: 'server action (inline)', tags: ['virtual'] });
        }
        walk(root, (n) => {
          if (n.type === 'call_expression') {
            const fn = n.childForFieldName('function');
            const arg = n.childForFieldName('arguments')?.namedChildren[0];
            const name = fn?.type === 'member_expression' ? fn.childForFieldName('property')?.text : fn?.text;
            const target = urlToRoute(arg);
            if (!target || !name) return;
            if (name === 'fetch' || /^(get|post|put|patch|delete)$/i.test(name)) {
              out.edges.push({ from: unit.fqn, to: `route:${target}`, kind: 'fetches', line: n.startPosition.row + 1, confidence: 0.8 });
            } else if (NAVIGATION_CALLS.has(name)) {
              out.edges.push({ from: unit.fqn, to: `route:${target}`, kind: 'links_to', line: n.startPosition.row + 1, confidence: 0.8 });
            }
          } else if (n.type === 'jsx_attribute' && n.namedChildren[0]?.text === 'href') {
            const v = n.namedChildren[1];
            const target = urlToRoute(v?.type === 'jsx_expression' ? v.namedChildren[0] : v);
            if (target) out.edges.push({ from: unit.fqn, to: `route:${target}`, kind: 'links_to', line: n.startPosition.row + 1, confidence: 0.8 });
          }
        });
      }
    }
    return out;
  },
};

export default nextjsPlugin;
