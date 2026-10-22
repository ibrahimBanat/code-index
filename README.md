# code-index

A structural code index for AI coding agents. It parses source with tree-sitter (an AST),
stores symbols and their relations in SQLite, and serves them in levels, so an agent reads
an outline first and the source of a single symbol last, instead of whole files.

```
code_map      repo / directory tree, key symbols per file, central files first
code_outline  every symbol in a file: one-line signatures + line ranges, no bodies
code_symbol   source of one symbol (a class gives its member outline)
code_refs     graph: callers, subclasses, dispatchers, routes ... (in / out)
code_search   ranked, camelCase-aware search over names, fqns and doc summaries
```

Measured on the Syarah monorepo (7,477 PHP files, full index 10.6 s, incremental ~0.3 s):

| target | whole file | outline | symbol | saved (outline + symbol) |
|---|---:|---:|---:|---:|
| `CPostOnline.php::getMake` | 45,434 | 5,798 | 53 | 87% |
| `OnlineFinanceOrder.php::rules` | 53,914 | 7,631 | 4,682 | 77% |
| `FinanceAutoRouteRunner.php::assignBank` | 12,504 | 1,425 | 240 | 87% |
| `InfoBipHelper.php::sendWhatsappMessage` | 14,365 | 1,026 | 2,155 | 78% |

That is the pessimistic path (full outline, then symbol). `code_search` → `code_symbol`
skips the outline. Reproduce with `npx tsx scripts/bench.ts <root> <file>::<symbol> ...`.

## Install

```bash
npm install
npm run build
```

Requires Node ≥ 20. better-sqlite3 is pinned to 11.x: 13.x segfaults on Node 22.7 / macOS.

## Set up a repo: `code-index init`

```bash
node dist/cli.js init --root /path/to/repo      # interactive
node dist/cli.js init --root /path/to/repo --yes # accept detected defaults
```

The wizard scans the repo and asks:

1. **Plugins** to run (file counts per language, frameworks marked detected / not detected).
2. **Directories to exclude**, with noisy ones pre-selected (migrations, tests, public, `web/js`, …).
3. **Import aliases** (TypeScript) that live in vite/webpack config rather than tsconfig.
4. **Token budgets**: lean / balanced / generous / custom.
5. **MCP tools** to expose.
6. **MCP clients** to register: Claude Code (project `.mcp.json` or user scope), Cursor,
   VS Code, Codex; and how they launch the server (this checkout, `npx` from git, or a global binary).
7. **Agent instructions**: an idempotent block in `AGENTS.md`, `CLAUDE.md` or a Cursor rule.

It shows a summary, writes only after you confirm, and can build the index at the end.

## Use with an agent (MCP)

Claude Code, from the repo you want indexed:

```bash
claude mcp add code-index -- node /path/to/code-index/dist/cli.js mcp
```

Cursor / other clients (`mcp.json`):

```json
{ "mcpServers": { "code-index": {
    "command": "node",
    "args": ["/path/to/code-index/dist/cli.js", "mcp", "--root", "/path/to/repo"] } } }
```

The server answers at once and indexes in the background; tools wait for the first pass.
Every query re-checks the files it touches (mtime/size, then content hash), so line numbers
never go stale after an edit.

## CLI

```bash
code-index index                        --root ../syarah
code-index map common --depth 2         --root ../syarah
code-index outline common/models/CPostOnline.php --match price
code-index symbol 'CPostOnline::getMake'
code-index refs component:notifications
code-index refs 'FinanceAutoRouteRunner::assignBank' --out
code-index search "auto route bank" --kind method
```

`--budget N` caps any output at about N tokens; cut output says how to narrow the query.
`./ci.sh <command>` is a dev wrapper that runs from source against `../syarah`.

The index is stored in `~/.cache/code-index/<repo>-<hash>.db` (override: `CODE_INDEX_DIR`),
so nothing is written into the indexed repo.

## Architecture

```
frontends   CLI · MCP server                       (thin, same Query API)
core        scanner → hash cache → SQLite store → PageRank → Query (token budgets)
plugins     LanguagePlugin  (php, …)   parse a file   → symbols + edges
            FrameworkPlugin (yii2, …)  enrich a file  → virtual symbols + edges
                                       enrich global  → config-driven symbols
```

The core knows only a generic model (`src/core/types.ts`):

- **Symbol**: `kind, name, fqn, parent, file, startLine, endLine, signature, doc, tags`.
  Kinds are open strings defined by plugins.
- **Edge**: `from, to, kind, line, confidence`. `to` is a name, joined to `Symbol.fqn` at
  query time. Conventions: `*::name` = receiver type unknown (low confidence);
  `~name` = unqualified function call.

File discovery uses `git ls-files -co --exclude-standard`, so `.gitignore` is respected.
Files are ranked with PageRank over the file dependency graph; maps and search list central
code first.

### Configuration: `.codeindex.json`

Written by `init`, or by hand. Every key is optional.

```json
{
  "enable": ["php", "yii2"],
  "exclude": ["console/migrations/", "dashboard/web/js/"],
  "pluginOptions": { "typescript": { "aliases": { "@hooks/": "src/hooks/" } } },
  "budgets": { "map": 800, "outline": 1200, "symbol": 2500, "refs": 1200, "search": 800 },
  "tools": ["code_map", "code_outline", "code_symbol", "code_refs", "code_search"],
  "plugins": ["./tools/my-plugin.js"]
}
```

`enable` empty or missing means all language plugins plus every framework whose `detect()`
passes. A change to plugin versions, `exclude` or `pluginOptions` triggers a full re-index.

### Built-in plugins

**php** (tree-sitter-php): namespaces and `use` resolution (aliases, groups), classes,
interfaces, traits, enums, methods, properties (incl. constructor promotion), constants,
functions, doc summaries. Edges: `extends`, `implements`, `uses_trait`, `calls`,
`instantiates`, `references` (`X::class`, `X::CONST`), `reads` (`$x->prop`).

**typescript** (`.ts .tsx .js .jsx .mjs .cjs .mts .cts`, tree-sitter typescript/tsx): functions,
React components (capitalised functions in `.tsx/.jsx`), classes, methods, fields, interfaces,
types, enums, top-level consts. fqn = `<path without ext and /index>::<name>`; a default export
is `<module>::default`. Resolves relative imports, tsconfig/jsconfig `paths` (all config
variants) and `pluginOptions.typescript.aliases`. Re-exports (`export { X } from`) and
`export default X` become `alias_of` edges, which `code_refs` follows, so barrel imports count as
uses. Edges: `calls`, `renders` (JSX), `instantiates`, `extends`, `implements`, `references`
(types, values passed by name).

**nextjs** (active when `package.json` depends on `next`):

| adds | from |
|---|---|
| `page` / `layout` / `loading` / `error` / `not_found` / `template` symbols, `handled_by` the default export | `app/**/page.tsx` etc. (route groups, `@slots` stripped) |
| `api_route` symbol listing its verbs, `handled_by` each `GET`/`POST`/… | `app/**/route.ts`, `pages/api/**` |
| `page` symbols | Pages Router `pages/**` |
| `middleware` symbol with its matcher | `middleware.ts` |
| `client_component` / `server_action` suffixes | `'use client'`, `'use server'` (file or inline) |
| `fetches` / `links_to` edges to routes | `fetch('/api/x')`, `axios.get(...)`, `<Link href>`, `redirect()`, `router.push()` |

Route ids normalise dynamic segments to `[*]`, so ``fetch(`/api/users/${id}`)`` joins
`app/api/users/[id]/route.ts`. Route signatures list config exports (`revalidate`, `dynamic`,
`generateStaticParams`, …) and client/server.

**yii2** (active when `composer.json` requires `yiisoft/yii2`):

| adds | from |
|---|---|
| `relation` symbols `Car::$owner` + `relation` edge to the target model | `getOwner() { return $this->hasOne(User::class, …) }` |
| `component` symbols + `configured_as` edge to the class | `'components' => [...]` (also inside `array_merge(...)`) in `*/config/main.php` |
| `uses_component` edges | `Yii::$app->notifications` |
| `dispatches` edges | `->push(new SomeJob(...))` |
| `route` symbols `route:<app>/<module…>/<controller>/<action>` + `handled_by` | `FooController::actionBar()` |
| `guarded_by` edges | `AuthItem::X` constants inside `behaviors()` |

In outlines, a framework symbol that starts on the same line as a real one is shown as a
suffix of it: `getMake(): ActiveQuery [L1011-1014] ⇒ relation $make: hasOne(CMake)`.

## Writing a plugin

A language plugin turns one file into symbols and edges:

```ts
import { loadGrammar } from 'code-index/dist/core/treesitter.js';
import type { LanguagePlugin } from 'code-index';

export default {
  id: 'go',
  version: '1',                 // bump when output changes: forces a full re-index
  extensions: ['.go'],
  async init() { this.parser = await loadGrammar('go'); },
  parse(path, src) {
    const tree = this.parser.parse(src);
    // ...walk tree, collect symbols / edges...
    return { symbols, edges, ast: tree.rootNode, dispose: () => tree.delete() };
  },
} satisfies LanguagePlugin & { parser?: any };
```

A framework plugin builds on a language plugin's `ast`:

```ts
export default {
  id: 'laravel', version: '1', dependsOn: ['php'],
  detect: (root) => /* composer.json has laravel/framework */ true,
  enrichFile(path, src, parsed) { return { symbols: [], edges: [] }; },  // cached per file
  globalInputs: (path) => path.startsWith('routes/'),                    // re-run global when these change
  enrichGlobal(ctx) { return { symbols: [], edges: [] }; },              // whole-repo pass
} satisfies FrameworkPlugin;
```

Load external plugins per repo with `.codeindex.json` at the repo root:

```json
{ "plugins": ["./tools/code-index-laravel.js"], "exclude": ["console/migrations/"] }
```

Grammars bundled in `tree-sitter-wasms` (php, go, typescript, javascript, python, java, …)
load with `loadGrammar(name)`. Always return `dispose` so WASM memory is freed.

## Known limits

- Receiver types are not inferred: `$order->save()` is stored as `*::save` and shown as
  "untyped uses" in `code_refs`. `$this->x()` and `X::y()` are resolved.
- Yii2 routes ignore `controllerMap`, `actions()` and URL rules; module ids are taken from
  the `modules/<id>/` path.
- Components configured only in `main-local.php` (git-ignored) are not indexed.
- TS: `export * from` is recorded but not expanded; untyped member calls (`obj.method()` on a
  local variable) are skipped to avoid `.map()`/`.then()` noise.
- Next.js: `next.config` rewrites/redirects and `basePath` are not applied to routes.
- The index for a large repo is ~140 MB (FTS + edges).

## Roadmap

1. Type inference for common cases (`@var`, typed params/properties, `new X` assignments)
   to resolve `*::method` edges.
2. More plugins: Go, Python; frameworks: Laravel, NestJS, Express.
3. One-line LLM summaries per file, cached by content hash, for `code_map`.
4. Benchmark harness: replay real tickets with and without the server, compare tokens and
   success rate.
