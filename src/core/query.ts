import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Indexer } from './indexer.js';
import { Store, type EdgeRow, type FileRow, type SymbolRow } from './store.js';

/** ~4 chars per token is close enough for budgeting. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

/** Collects output lines until the token budget is spent, then counts what was cut. */
class Budget {
  private lines: string[] = [];
  private used = 0;
  omitted = 0;
  constructor(private readonly limit: number) {}

  add(line: string): boolean {
    const cost = estimateTokens(line) + 1;
    if (this.omitted || this.used + cost > this.limit) {
      this.omitted++;
      return false;
    }
    this.lines.push(line);
    this.used += cost;
    return true;
  }

  toString(hint = ''): string {
    const tail = this.omitted ? [`… ${this.omitted} more lines cut by budget${hint ? ` — ${hint}` : ''}`] : [];
    return [...this.lines, ...tail].join('\n');
  }
}

const range = (s: SymbolRow) => (s.start_line === s.end_line ? `L${s.start_line}` : `L${s.start_line}-${s.end_line}`);
const CONTAINER_KINDS = new Set(['class', 'interface', 'trait', 'enum', 'module', 'namespace', 'struct']);
const COLLAPSED_KINDS = new Set(['property', 'const', 'field']);
const isVirtual = (s: SymbolRow) => s.tags.split(',').includes('virtual');

export class Query {
  private readonly budgets: NonNullable<Indexer['config']['budgets']>;

  constructor(
    private readonly store: Store,
    private readonly indexer: Indexer,
  ) {
    this.budgets = indexer.config.budgets ?? {};
  }

  private get db() {
    return this.store.db;
  }

  /** Directory tree with file counts and each file's top-level symbols, central files first. */
  repoMap(path = '', depth = 2, budget = this.budgets.map ?? 1500): string {
    const prefix = path.replace(/^\.?\/*/, '').replace(/\/*$/, '');
    const base = prefix ? prefix + '/' : '';
    const files = (this.db.prepare(`SELECT * FROM files WHERE path LIKE ? ORDER BY path`).all(base + '%') as FileRow[]);
    if (!files.length) return `No indexed files under "${prefix || '.'}".`;

    const tops = this.db
      .prepare(
        `SELECT file, kind, name FROM symbols
         WHERE parent IS NULL AND kind != 'export' AND (',' || tags || ',') NOT LIKE '%,virtual,%'
           AND file LIKE ? ORDER BY file, start_line`,
      )
      .all(base + '%') as { file: string; kind: string; name: string }[];
    const topByFile = new Map<string, string[]>();
    for (const t of tops) {
      if (!topByFile.has(t.file)) topByFile.set(t.file, []);
      topByFile.get(t.file)!.push(t.name);
    }

    interface Dir { name: string; dirs: Map<string, Dir>; files: FileRow[]; count: number; rank: number }
    const tree: Dir = { name: prefix || '.', dirs: new Map(), files: [], count: 0, rank: 0 };
    for (const f of files) {
      const parts = f.path.slice(base.length).split('/');
      let d = tree;
      d.count++; d.rank += f.rank;
      for (const p of parts.slice(0, -1)) {
        if (!d.dirs.has(p)) d.dirs.set(p, { name: p, dirs: new Map(), files: [], count: 0, rank: 0 });
        d = d.dirs.get(p)!;
        d.count++; d.rank += f.rank;
      }
      d.files.push(f);
    }

    const out = new Budget(budget);
    out.add(`${tree.name}/  (${tree.count} files)`);
    const PER_DIR = 25;
    const render = (d: Dir, level: number, indent: string) => {
      const dirs = [...d.dirs.values()].sort((a, b) => b.rank - a.rank);
      const fileList = [...d.files].sort((a, b) => b.rank - a.rank);
      const entries = dirs.length + fileList.length;
      let shown = 0;
      for (const sub of dirs) {
        if (shown++ >= PER_DIR) break;
        out.add(`${indent}${sub.name}/  (${sub.count})`);
        if (level < depth) render(sub, level + 1, indent + '  ');
      }
      for (const f of fileList) {
        if (shown++ >= PER_DIR) break;
        const name = f.path.split('/').pop()!;
        const syms = topByFile.get(f.path) ?? [];
        const label = syms.length ? ` — ${syms.slice(0, 3).join(', ')}${syms.length > 3 ? ` +${syms.length - 3}` : ''}` : '';
        out.add(`${indent}${name}${label}`);
      }
      if (entries > PER_DIR) out.add(`${indent}… +${entries - PER_DIR} more (map a subdirectory)`);
    };
    render(tree, 1, '  ');
    return out.toString('call map on a subdirectory or lower depth');
  }

  /** Every symbol in a file as one-line signatures with line ranges. No bodies. */
  outline(file: string, opts: { match?: string; budget?: number } = {}): string {
    file = file.replace(/^\.?\//, '');
    this.indexer.ensureFresh(file);
    const f = this.store.getFile(file);
    if (!f) return `Not indexed: ${file}`;
    const syms = this.db
      .prepare(`SELECT * FROM symbols WHERE file = ? ORDER BY start_line, id`)
      .all(file) as SymbolRow[];
    const out = new Budget(opts.budget ?? this.budgets.outline ?? 2000);
    out.add(`${file}  (${f.lang}, ${f.lines} lines)`);
    this.renderTree(syms, out, opts.match);
    return out.toString('pass match= to filter members, or call symbol');
  }

  private renderTree(syms: SymbolRow[], out: Budget, match?: string, baseIndent = ''): void {
    const byFqn = new Map(syms.map((s) => [s.fqn, s]));
    const depthOf = (s: SymbolRow): number => {
      let d = 0;
      for (let p = s.parent; p && byFqn.has(p) && d < 10; p = byFqn.get(p)!.parent) d++;
      return d;
    };
    const m = match?.toLowerCase();
    // Without a filter, data members are collapsed to name lists so behaviour (methods, relations, routes) fits the budget.
    const collapsed = new Map<string, Map<string, string[]>>();
    if (!m) {
      for (const s of syms) {
        if (!COLLAPSED_KINDS.has(s.kind) || !s.parent || !byFqn.has(s.parent)) continue;
        const kinds = collapsed.get(s.parent) ?? new Map<string, string[]>();
        kinds.set(s.kind, [...(kinds.get(s.kind) ?? []), s.name]);
        collapsed.set(s.parent, kinds);
      }
    }
    // Framework-derived (virtual) symbols that start on the same line as a real one are shown as a suffix of it.
    const at = (s: SymbolRow) => `${s.parent}|${s.start_line}`;
    const realAt = new Set(syms.filter((s) => !isVirtual(s)).map(at));
    const suffixes = new Map<string, string[]>();
    for (const s of syms) {
      if (isVirtual(s) && realAt.has(at(s))) suffixes.set(at(s), [...(suffixes.get(at(s)) ?? []), s.signature]);
    }
    for (const s of syms) {
      const d = depthOf(s);
      if (m && d > 0 && !s.name.toLowerCase().includes(m)) continue;
      if (collapsed.has(s.parent ?? '') && COLLAPSED_KINDS.has(s.kind)) continue;
      if (isVirtual(s) && realAt.has(at(s))) continue;
      const doc = s.doc ? `  // ${s.doc}` : '';
      const extra = suffixes.get(at(s))?.map((x) => `  ⇒ ${x}`).join('') ?? '';
      out.add(`${baseIndent}${'  '.repeat(d)}${s.signature}  [${range(s)}]${extra}${doc}`);
      for (const [kind, names] of collapsed.get(s.fqn) ?? []) {
        const list = names.length > 40 ? `${names.slice(0, 40).join(', ')} +${names.length - 40}` : names.join(', ');
        out.add(`${baseIndent}${'  '.repeat(d + 1)}${kind} (${names.length}): ${list}`);
      }
    }
  }

  /** Resolve a user-supplied name to symbols: exact fqn, Class::member suffix, short name, then FTS. */
  resolve(name: string, limit = 10): SymbolRow[] {
    const q = name.trim().replace(/^\\/, '').replace(/\(\)$/, '');
    const exact = this.db.prepare(`SELECT * FROM symbols WHERE fqn = ? COLLATE NOCASE LIMIT ?`).all(q, limit) as SymbolRow[];
    if (exact.length) return exact;
    const esc = q.replace(/[!%_]/g, '!$&');
    const suffix = this.db
      .prepare(
        `SELECT s.* FROM symbols s LEFT JOIN files f ON f.path = s.file
         WHERE s.fqn LIKE ? ESCAPE '!' OR s.fqn LIKE ? ESCAPE '!' OR s.fqn LIKE ? ESCAPE '!'
         ORDER BY f.rank DESC LIMIT ?`,
      )
      .all('%\\' + esc, '%/' + esc, '%::' + esc, limit) as SymbolRow[];
    if (suffix.length) return suffix;
    const short = q.includes('::') ? q.split('::').pop()! : q;
    const byName = this.db
      .prepare(
        `SELECT s.* FROM symbols s LEFT JOIN files f ON f.path = s.file
         WHERE s.name = ? COLLATE NOCASE ORDER BY f.rank DESC LIMIT ?`,
      )
      .all(short, limit) as SymbolRow[];
    if (byName.length) return byName;
    return this.searchRows(q, undefined, limit);
  }

  /** Source of one symbol. Containers (classes) return their member outline unless full=true. */
  symbol(name: string, opts: { full?: boolean; budget?: number } = {}): string {
    let hits = this.resolve(name);
    if (!hits.length) return `No symbol matches "${name}".`;
    if (hits.length > 1) {
      const out = new Budget(opts.budget ?? 1000);
      out.add(`${hits.length} matches for "${name}" — call again with one fqn:`);
      for (const h of hits) out.add(`  ${h.kind} ${h.fqn}  ${h.file}:${h.start_line}`);
      return out.toString();
    }
    this.indexer.ensureFresh(hits[0].file);
    hits = this.resolve(hits[0].fqn, 1); // line numbers may have moved
    const s = hits[0];
    if (!s) return `Symbol "${name}" disappeared after re-index.`;

    const out = new Budget(opts.budget ?? this.budgets.symbol ?? 4000);
    out.add(`${s.kind} ${s.fqn}`);
    out.add(`${s.file}:${s.start_line}-${s.end_line}${s.doc ? `  // ${s.doc}` : ''}`);
    const members = this.db
      .prepare(`SELECT * FROM symbols WHERE parent = ? AND file = ? ORDER BY start_line, id`)
      .all(s.fqn, s.file) as SymbolRow[];

    if (CONTAINER_KINDS.has(s.kind) && !opts.full) {
      this.renderTree([s, ...members], out);
      return out.toString('use full=true for source, or symbol on a member');
    }
    const src = readFileSync(join(this.indexer.root, s.file), 'utf8').split('\n');
    out.add('```');
    for (const line of src.slice(s.start_line - 1, s.end_line)) if (!out.add(line)) break;
    const cut = out.omitted;
    const body = out.toString();
    return cut ? `${body}\n(truncated: raise budget for the rest)` : body + '\n```';
  }

  /**
   * Graph neighbours. direction "in" = who uses this (callers, subclasses, dispatchers);
   * "out" = what this uses.
   */
  refs(name: string, opts: { direction?: 'in' | 'out'; kinds?: string[]; budget?: number } = {}): string {
    const hits = this.resolve(name, 5);
    if (!hits.length) return `No symbol matches "${name}".`;
    const s = hits[0];
    const dir = opts.direction ?? 'in';
    const out = new Budget(opts.budget ?? this.budgets.refs ?? 2000);
    const kindFilter = (e: EdgeRow) => !opts.kinds?.length || opts.kinds.includes(e.kind);
    out.add(`${dir === 'in' ? 'Used by' : 'Uses'}: ${s.kind} ${s.fqn}${hits.length > 1 ? `  (+${hits.length - 1} other matches)` : ''}`);

    if (dir === 'out') {
      const edges = (this.db
        .prepare(
          `SELECT * FROM edges WHERE from_fqn = ? OR (from_fqn LIKE ? ESCAPE '!' AND ? = 1) ORDER BY line`,
        )
        .all(s.fqn, s.fqn.replace(/[!%_]/g, '!$&') + '::%', CONTAINER_KINDS.has(s.kind) ? 1 : 0) as EdgeRow[])
        .filter(kindFilter);
      const locate = this.db.prepare(`SELECT file, start_line FROM symbols WHERE fqn = ? COLLATE NOCASE LIMIT 1`);
      for (const e of edges) {
        const t = locate.get(e.to_name) as { file: string; start_line: number } | undefined;
        const where = t ? `  → ${t.file}:${t.start_line}` : '';
        out.add(`  ${e.kind} ${e.to_name}  (L${e.line})${where}`);
      }
      if (!edges.length) out.add('  (none)');
      return out.toString('filter with kinds=');
    }

    const targets = [s.fqn];
    if (s.kind === 'function') targets.push('~' + s.name);
    // Re-exports and default-export aliases point at this symbol; their importers are its users too.
    const aliases = this.db
      .prepare(`SELECT DISTINCT from_fqn FROM edges WHERE kind = 'alias_of' AND to_name = ?`)
      .all(s.fqn) as { from_fqn: string }[];
    for (const a of aliases) targets.push(a.from_fqn);
    if (aliases.length) out.add(`  (also via ${aliases.map((a) => a.from_fqn).join(', ')})`);
    const direct = (this.db
      .prepare(
        `SELECT * FROM edges WHERE to_name COLLATE NOCASE IN (${targets.map(() => '?').join(',')}) ORDER BY file, line`,
      )
      .all(...targets) as EdgeRow[]).filter(kindFilter);
    for (const e of direct) out.add(`  ${e.kind}  ${e.from_fqn}  ${e.file}:${e.line}`);

    if (CONTAINER_KINDS.has(s.kind)) {
      const members = this.db
        .prepare(
          `SELECT to_name, count(*) AS n FROM edges WHERE to_name LIKE ? ESCAPE '!' GROUP BY to_name ORDER BY n DESC LIMIT 15`,
        )
        .all(s.fqn.replace(/[!%_]/g, '!$&') + '::%') as { to_name: string; n: number }[];
      if (members.length) {
        out.add(`  member usage (call refs on a member for sites):`);
        for (const m of members) out.add(`    ${m.to_name}  ×${m.n}`);
      }
    }

    if (s.parent && !CONTAINER_KINDS.has(s.kind)) {
      // Receiver type unknown: `$x->name()` / `$x->name`. A getter getFoo() is also reached as `$x->foo`.
      const loose = new Set<string>();
      if (s.kind === 'method') loose.add(`*::${s.name}`);
      else loose.add(`*::$${s.name}`);
      const getter = /^get([A-Z]\w*)$/.exec(s.name);
      if (s.kind === 'method' && getter) loose.add(`*::$${getter[1].charAt(0).toLowerCase()}${getter[1].slice(1)}`);
      for (const target of loose) {
        const c = this.db
          .prepare(`SELECT count(*) AS n, count(DISTINCT file) AS f FROM edges WHERE to_name = ?`)
          .get(target) as { n: number; f: number };
        if (!c.n) continue;
        const shown = target.replace('*::', '->');
        out.add(`  + ${c.n} untyped uses of ${shown} in ${c.f} files (receiver unknown; may be other classes)`);
        const sample = this.db
          .prepare(`SELECT DISTINCT from_fqn, file, line FROM edges WHERE to_name = ? ORDER BY file, line LIMIT 15`)
          .all(target) as EdgeRow[];
        for (const e of sample) out.add(`    ?  ${e.from_fqn}  ${e.file}:${e.line}`);
      }
    }

    if (!direct.length && out.omitted === 0) out.add('  (no resolved references)');
    return out.toString('filter with kinds=');
  }

  private searchRows(query: string, kind: string | undefined, limit: number): SymbolRow[] {
    const terms = Store.tokens(query).split(' ').filter(Boolean);
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t}"*`).join(' AND ');
    return this.db
      .prepare(
        `SELECT s.*, bm25(symbols_fts) AS score FROM symbols_fts
         JOIN symbols s ON s.id = symbols_fts.rowid
         LEFT JOIN files f ON f.path = s.file
         WHERE symbols_fts MATCH ? ${kind ? 'AND s.kind = ?' : ''}
         ORDER BY (s.name = ? COLLATE NOCASE) DESC, score - 2 * coalesce(f.rank, 0) LIMIT ?`,
      )
      .all(...([match, kind, query, limit].filter((v) => v !== undefined) as (string | number)[])) as SymbolRow[];
  }

  /** Ranked symbol search over names, fqns and doc summaries (camelCase-aware). */
  search(query: string, opts: { kind?: string; limit?: number; budget?: number } = {}): string {
    const rows = this.searchRows(query, opts.kind, opts.limit ?? 20);
    if (!rows.length) return `No symbols match "${query}".`;
    const out = new Budget(opts.budget ?? this.budgets.search ?? 1500);
    for (const s of rows) out.add(`${s.kind} ${s.fqn}  ${s.file}:${s.start_line}${s.doc ? `  // ${s.doc}` : ''}`);
    return out.toString();
  }

  stats(): string {
    const q = (sql: string) => this.db.prepare(sql).all() as Record<string, unknown>[];
    const files = q(`SELECT lang, count(*) AS n FROM files GROUP BY lang`);
    const kinds = q(`SELECT kind, count(*) AS n FROM symbols GROUP BY kind ORDER BY n DESC`);
    const edges = q(`SELECT kind, count(*) AS n FROM edges GROUP BY kind ORDER BY n DESC`);
    const fmt = (rows: Record<string, unknown>[], k: string) => rows.map((r) => `${r[k]}=${r.n}`).join(', ');
    return [
      `plugins: ${this.indexer.activePlugins().join(', ')}`,
      `files: ${fmt(files, 'lang')}`,
      `symbols: ${fmt(kinds, 'kind')}`,
      `edges: ${fmt(edges, 'kind')}`,
    ].join('\n');
  }
}
