import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { pageRank } from './rank.js';
import { Store } from './store.js';
import {
  isLanguagePlugin,
  type FileResult,
  type FrameworkPlugin,
  type GlobalContext,
  type LanguagePlugin,
  type ParsedFile,
  type Plugin,
} from './types.js';

export interface IndexConfig {
  /** Path prefixes to skip, repo-relative. */
  exclude: string[];
  maxFileBytes: number;
  /** Extra plugin modules to load (paths relative to the repo root), default-exporting a Plugin. */
  plugins: string[];
  /** Plugin ids to run. Empty/missing = every plugin whose detect() passes (languages always run). */
  enable?: string[];
  /** Per-plugin options, keyed by plugin id. */
  pluginOptions?: Record<string, Record<string, unknown>>;
  /** Default token budgets per query. */
  budgets?: Partial<Record<'map' | 'outline' | 'symbol' | 'refs' | 'search', number>>;
  /** MCP tools to expose. Missing = all. */
  tools?: string[];
}

export const DEFAULT_CONFIG: IndexConfig = {
  exclude: ['vendor/', 'node_modules/', '.git/', 'runtime/', 'web/assets/', 'dist/', 'build/'],
  maxFileBytes: 1_000_000,
  plugins: [],
};

export interface IndexStats {
  scanned: number;
  updated: number;
  unchanged: number;
  removed: number;
  ms: number;
}

const GLOBAL_ORIGIN_SUFFIX = ':global';

export class Indexer {
  private langs = new Map<string, LanguagePlugin>();
  private frameworks: FrameworkPlugin[] = [];

  constructor(
    readonly root: string,
    readonly store: Store,
    private readonly plugins: Plugin[],
    readonly config: IndexConfig = DEFAULT_CONFIG,
  ) {}

  async init(): Promise<void> {
    const enabled = (p: Plugin) => !this.config.enable?.length || this.config.enable.includes(p.id);
    for (const p of this.plugins) {
      if (!isLanguagePlugin(p) || !enabled(p)) continue;
      await p.init?.(this.root, this.config.pluginOptions?.[p.id]);
      for (const ext of p.extensions) this.langs.set(ext, p);
    }
    const langIds = new Set([...this.langs.values()].map((l) => l.id));
    this.frameworks = this.plugins
      .filter((p): p is FrameworkPlugin => !isLanguagePlugin(p))
      .filter((f) => f.dependsOn.every((d) => langIds.has(d)))
      .filter((f) => (this.config.enable?.length ? this.config.enable.includes(f.id) : f.detect(this.root)));
  }

  /** Plugin versions + the config that changes their output; any change forces a full re-index. */
  private pluginSignature(): string {
    const langs = [...new Set(this.langs.values())];
    const ids = [...langs, ...this.frameworks].map((p) => `${p.id}@${p.version ?? '0'}`).join(',');
    const cfg = createHash('sha1')
      .update(JSON.stringify([this.config.exclude, this.config.pluginOptions ?? {}, this.config.maxFileBytes]))
      .digest('hex')
      .slice(0, 8);
    return `${ids}#${cfg}`;
  }

  activePlugins(): string[] {
    return [...new Set([...this.langs.values()].map((l) => l.id)), ...this.frameworks.map((f) => f.id)];
  }

  langFor(path: string): LanguagePlugin | undefined {
    return this.langs.get(extname(path).toLowerCase());
  }

  /** Candidate files: git-tracked + untracked-not-ignored when in a git repo, else a directory walk. */
  listFiles(): string[] {
    let files: string[];
    try {
      const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
        cwd: this.root,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      files = out.toString('utf8').split('\0').filter(Boolean);
    } catch {
      files = this.walkDir(this.root);
    }
    return files.filter((f) => this.langFor(f) && !this.config.exclude.some((x) => f.startsWith(x)));
  }

  private walkDir(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      const rel = relative(this.root, abs).split(sep).join('/');
      if (this.config.exclude.some((x) => (rel + '/').startsWith(x))) continue;
      if (e.isDirectory()) this.walkDir(abs, out);
      else if (e.isFile()) out.push(rel);
    }
    return out;
  }

  async indexAll(log: (msg: string) => void = () => {}): Promise<IndexStats> {
    const t0 = Date.now();
    const files = this.listFiles();
    const known = new Map(this.store.allFiles().map((f) => [f.path, f]));
    const stats: IndexStats = { scanned: files.length, updated: 0, unchanged: 0, removed: 0, ms: 0 };
    const signature = this.pluginSignature();
    if (this.store.getMeta('plugins') !== signature) {
      log(`plugin set changed (${signature}); full re-index`);
      this.store.tx(() => this.store.allFiles().forEach((f) => this.store.deleteFile(f.path)));
      known.clear();
    }
    let globalDirty = this.store.getMeta('frameworks') !== this.frameworks.map((f) => f.id).join(',');

    this.store.tx(() => {
      for (const f of files) {
        known.delete(f);
        const changed = this.refreshFile(f);
        if (changed) {
          stats.updated++;
          if (this.frameworks.some((fw) => fw.globalInputs?.(f))) globalDirty = true;
          if (stats.updated % 500 === 0) log(`indexed ${stats.updated} files…`);
        } else stats.unchanged++;
      }
      for (const gone of known.keys()) {
        this.store.deleteFile(gone);
        stats.removed++;
      }
    });

    if (globalDirty || stats.updated || stats.removed) {
      if (globalDirty) this.runGlobal();
      this.computeRanks();
    }
    this.store.setMeta('plugins', signature);
    stats.ms = Date.now() - t0;
    return stats;
  }

  /**
   * Re-index one file when its content changed. Cheap stat check first, content hash second.
   * Returns true when rows were rewritten.
   */
  refreshFile(path: string): boolean {
    const abs = join(this.root, path);
    const prev = this.store.getFile(path);
    if (!existsSync(abs)) {
      if (prev) this.store.deleteFile(path);
      return !!prev;
    }
    const st = statSync(abs);
    if (st.size > this.config.maxFileBytes) return false;
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) return false;

    const src = readFileSync(abs, 'utf8');
    const hash = createHash('sha1').update(src).digest('hex');
    if (prev && prev.hash === hash) {
      this.store.touchFile(path, st.mtimeMs, st.size);
      return false;
    }

    const lang = this.langFor(path)!;
    this.store.clearRows({ file: path });
    const parsed = this.safeParse(lang, path, src);
    this.write(path, parsed, lang.id);
    for (const fw of this.frameworks) {
      if (!fw.enrichFile || !fw.dependsOn.includes(lang.id)) continue;
      try {
        this.write(path, fw.enrichFile(path, src, parsed), fw.id);
      } catch (e) {
        process.stderr.write(`[code-index] ${fw.id} failed on ${path}: ${(e as Error).message}\n`);
      }
    }
    parsed.dispose?.();
    this.store.upsertFile({
      path, lang: lang.id, hash, mtime: st.mtimeMs, size: st.size, lines: src.split('\n').length,
    });
    return true;
  }

  /** Query-time freshness: re-index a file the agent is about to read, plus globals it feeds. */
  ensureFresh(path: string): void {
    if (!this.langFor(path)) return;
    const changed = this.store.tx(() => this.refreshFile(path));
    if (changed && this.frameworks.some((fw) => fw.globalInputs?.(path))) this.runGlobal();
  }

  private safeParse(lang: LanguagePlugin, path: string, src: string): ParsedFile {
    try {
      return lang.parse(path, src);
    } catch (e) {
      process.stderr.write(`[code-index] ${lang.id} failed on ${path}: ${(e as Error).message}\n`);
      return { symbols: [], edges: [] };
    }
  }

  private write(path: string, r: FileResult, origin: string): void {
    for (const s of r.symbols) s.file ||= path;
    this.store.insertSymbols(r.symbols, origin);
    this.store.insertEdges(r.edges, path, origin);
  }

  runGlobal(): void {
    const parsed: ParsedFile[] = [];
    const ctx: GlobalContext = {
      root: this.root,
      files: () => this.store.allFiles().map((f) => f.path),
      parse: (path) => {
        const lang = this.langFor(path);
        const abs = join(this.root, path);
        if (!lang || !existsSync(abs)) return null;
        const p = this.safeParse(lang, path, readFileSync(abs, 'utf8'));
        parsed.push(p);
        return p;
      },
    };
    this.store.tx(() => {
      for (const fw of this.frameworks) {
        const origin = fw.id + GLOBAL_ORIGIN_SUFFIX;
        this.store.clearRows({ origin });
        if (!fw.enrichGlobal) continue;
        const r = fw.enrichGlobal(ctx);
        this.store.insertSymbols(r.symbols, origin);
        const byFile = new Map<string, typeof r.edges>();
        // Global edges are attributed to the file of their source symbol when known.
        const fileOf = new Map(r.symbols.map((s) => [s.fqn, s.file ?? '']));
        for (const e of r.edges) {
          const f = fileOf.get(e.from) ?? '';
          byFile.set(f, [...(byFile.get(f) ?? []), e]);
        }
        for (const [f, edges] of byFile) this.store.insertEdges(edges, f, origin);
      }
      this.store.setMeta('frameworks', this.frameworks.map((f) => f.id).join(','));
    });
    for (const p of parsed) p.dispose?.();
  }

  computeRanks(): void {
    const nodes = this.store.allFiles().map((f) => f.path);
    this.store.setRanks(pageRank(nodes, this.store.fileGraph()));
  }
}

export function loadConfig(root: string): IndexConfig {
  const path = join(root, '.codeindex.json');
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const user = JSON.parse(readFileSync(path, 'utf8')) as Partial<IndexConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...user,
    exclude: [...DEFAULT_CONFIG.exclude, ...(user.exclude ?? [])],
  };
}
