/**
 * Generic data model. The core knows nothing about any language or framework:
 * kinds and edge kinds are open strings that plugins define.
 */

export interface SymbolRec {
  /** Open string: "class", "method", "function", "relation", "route", ... */
  kind: string;
  /** Short name, e.g. "getOwner". */
  name: string;
  /** Fully qualified, unique-ish name, e.g. "app\\models\\Car::getOwner". Not required to be unique. */
  fqn: string;
  /** fqn of the containing symbol (class for a method), or null for top level. */
  parent?: string | null;
  /** Repo-relative path. Filled in by the indexer when a plugin leaves it empty. */
  file?: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** One-line declaration, without body. */
  signature: string;
  /** First sentence of the doc comment. */
  doc?: string;
  tags?: string[];
}

export interface EdgeRec {
  /** fqn of the source symbol, or the file path for top-level code. */
  from: string;
  /**
   * Target name. Usually an fqn that may match a SymbolRec.fqn. Conventions:
   *   "*::name"  receiver type unknown (low confidence)
   *   "~name"    unqualified function call, resolved at query time against short names
   */
  to: string;
  /** Open string: "extends", "implements", "calls", "instantiates", "dispatches", ... */
  kind: string;
  line: number;
  /** 0..1 */
  confidence?: number;
}

export interface FileResult {
  symbols: SymbolRec[];
  edges: EdgeRec[];
}

export interface ParsedFile<A = unknown> extends FileResult {
  /** Language-specific syntax data, handed to framework plugins. Never stored. */
  ast?: A;
  /** Free native/WASM memory held by `ast`. Called by the indexer when it is done with the file. */
  dispose?: () => void;
}

export interface LanguagePlugin<A = unknown> {
  id: string;
  /** Bump when output changes; a new version forces a full re-index. */
  version?: string;
  /** Lower-case, with dot: [".php"]. */
  extensions: string[];
  /**
   * Called once with the repo root and this plugin's entry from `.codeindex.json` "pluginOptions"
   * (e.g. to read tsconfig path aliases).
   */
  init?(root: string, options?: Record<string, unknown>): Promise<void>;
  parse(path: string, src: string): ParsedFile<A>;
}

export interface GlobalContext {
  root: string;
  /** All indexed repo-relative paths. */
  files(): string[];
  /** Parse a file with its language plugin; null when no plugin handles it. */
  parse(path: string): ParsedFile | null;
}

export interface FrameworkPlugin {
  id: string;
  /** Bump when output changes; a new version forces a full re-index. */
  version?: string;
  /** Language plugin ids this plugin needs. */
  dependsOn: string[];
  /** True when the framework is present in the repo. */
  detect(root: string): boolean;
  /** Per-file enrichment, cached with the file (re-run only when the file changes). */
  enrichFile?(path: string, src: string, parsed: ParsedFile): FileResult;
  /** True when a change to this file must re-run enrichGlobal. */
  globalInputs?(path: string): boolean;
  /** Whole-repo enrichment (config files, registries). Its rows are replaced on each run. */
  enrichGlobal?(ctx: GlobalContext): FileResult;
}

export type Plugin = LanguagePlugin | FrameworkPlugin;

export function isLanguagePlugin(p: Plugin): p is LanguagePlugin {
  return Array.isArray((p as LanguagePlugin).extensions);
}
