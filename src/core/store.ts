import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EdgeRec, SymbolRec } from './types.js';

const SCHEMA_VERSION = '2';

export interface FileRow {
  path: string;
  lang: string;
  hash: string;
  mtime: number;
  size: number;
  lines: number;
  rank: number;
}

export interface SymbolRow {
  id: number;
  kind: string;
  name: string;
  fqn: string;
  parent: string | null;
  file: string;
  start_line: number;
  end_line: number;
  signature: string;
  doc: string | null;
  tags: string;
  origin: string;
}

export interface EdgeRow {
  id: number;
  file: string;
  from_fqn: string;
  to_name: string;
  kind: string;
  line: number;
  confidence: number;
  origin: string;
}

/** "getOwnerCar" + "app\\models\\Car::getOwnerCar" -> "get owner car app models ..." for FTS. */
function tokens(...parts: (string | null | undefined)[]): string {
  return parts
    .filter(Boolean)
    .join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .trim();
}

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  private migrate(): void {
    const has = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`).get();
    const version = has
      ? (this.db.prepare(`SELECT v FROM meta WHERE k='schema'`).get() as { v: string } | undefined)?.v
      : undefined;
    if (version === SCHEMA_VERSION) return;

    this.db.exec(`
      DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS symbols;
      DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS symbols_fts;
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE files (
        path TEXT PRIMARY KEY, lang TEXT, hash TEXT, mtime REAL, size INTEGER, lines INTEGER, rank REAL DEFAULT 0
      );
      CREATE TABLE symbols (
        id INTEGER PRIMARY KEY, kind TEXT, name TEXT, fqn TEXT, parent TEXT, file TEXT,
        start_line INTEGER, end_line INTEGER, signature TEXT, doc TEXT, tags TEXT, origin TEXT
      );
      CREATE INDEX symbols_fqn ON symbols(fqn COLLATE NOCASE);
      CREATE INDEX symbols_name ON symbols(name COLLATE NOCASE);
      CREATE INDEX symbols_file ON symbols(file);
      CREATE INDEX symbols_parent ON symbols(parent);
      CREATE TABLE edges (
        id INTEGER PRIMARY KEY, file TEXT, from_fqn TEXT, to_name TEXT, kind TEXT,
        line INTEGER, confidence REAL, origin TEXT
      );
      CREATE INDEX edges_to ON edges(to_name COLLATE NOCASE);
      CREATE INDEX edges_from ON edges(from_fqn);
      CREATE INDEX edges_file ON edges(file);
      CREATE VIRTUAL TABLE symbols_fts USING fts5(tokens, content='', tokenize='unicode61');
      INSERT INTO meta VALUES ('schema', '${SCHEMA_VERSION}');
    `);
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getFile(path: string): FileRow | undefined {
    return this.db.prepare(`SELECT * FROM files WHERE path = ?`).get(path) as FileRow | undefined;
  }

  allFiles(): FileRow[] {
    return this.db.prepare(`SELECT * FROM files`).all() as FileRow[];
  }

  upsertFile(f: Omit<FileRow, 'rank'>): void {
    this.db
      .prepare(
        `INSERT INTO files (path, lang, hash, mtime, size, lines) VALUES (@path, @lang, @hash, @mtime, @size, @lines)
         ON CONFLICT(path) DO UPDATE SET lang=@lang, hash=@hash, mtime=@mtime, size=@size, lines=@lines`,
      )
      .run(f);
  }

  /** Touch only the stat fields (content hash unchanged). */
  touchFile(path: string, mtime: number, size: number): void {
    this.db.prepare(`UPDATE files SET mtime = ?, size = ? WHERE path = ?`).run(mtime, size, path);
  }

  deleteFile(path: string): void {
    this.clearRows({ file: path });
    this.db.prepare(`DELETE FROM files WHERE path = ?`).run(path);
  }

  /** Remove rows of a file (all origins) or of one origin (all files). */
  clearRows(by: { file?: string; origin?: string }): void {
    const [col, val] = by.file !== undefined ? ['file', by.file] : ['origin', by.origin];
    const ids = this.db.prepare(`SELECT id FROM symbols WHERE ${col} = ?`).all(val) as { id: number }[];
    const delFts = this.db.prepare(`INSERT INTO symbols_fts(symbols_fts, rowid, tokens) VALUES ('delete', ?, ?)`);
    const getTok = this.db.prepare(`SELECT name, fqn, doc, kind FROM symbols WHERE id = ?`);
    for (const { id } of ids) {
      const s = getTok.get(id) as { name: string; fqn: string; doc: string | null; kind: string };
      delFts.run(id, tokens(s.name, s.fqn, s.doc, s.kind));
    }
    this.db.prepare(`DELETE FROM symbols WHERE ${col} = ?`).run(val);
    this.db.prepare(`DELETE FROM edges WHERE ${col} = ?`).run(val);
  }

  insertSymbols(rows: SymbolRec[], origin: string): void {
    const ins = this.db.prepare(
      `INSERT INTO symbols (kind, name, fqn, parent, file, start_line, end_line, signature, doc, tags, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const fts = this.db.prepare(`INSERT INTO symbols_fts(rowid, tokens) VALUES (?, ?)`);
    for (const s of rows) {
      const r = ins.run(
        s.kind, s.name, s.fqn, s.parent ?? null, s.file ?? '', s.startLine, s.endLine,
        s.signature, s.doc ?? null, (s.tags ?? []).join(','), origin,
      );
      fts.run(r.lastInsertRowid, tokens(s.name, s.fqn, s.doc, s.kind));
    }
  }

  insertEdges(rows: EdgeRec[], file: string, origin: string): void {
    const ins = this.db.prepare(
      `INSERT INTO edges (file, from_fqn, to_name, kind, line, confidence, origin) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of rows) ins.run(file, e.from, e.to, e.kind, e.line, e.confidence ?? 1, origin);
  }

  setRanks(ranks: Map<string, number>): void {
    const up = this.db.prepare(`UPDATE files SET rank = ? WHERE path = ?`);
    this.tx(() => {
      for (const [path, r] of ranks) up.run(r, path);
    });
  }

  /** File-level dependency graph: edges whose target resolves to a symbol in another file. */
  fileGraph(): { src: string; dst: string }[] {
    return this.db
      .prepare(
        `SELECT DISTINCT e.file AS src, s.file AS dst FROM edges e
         JOIN symbols s ON s.fqn = e.to_name COLLATE NOCASE
         WHERE e.file != s.file AND s.file != ''`,
      )
      .all() as { src: string; dst: string }[];
  }

  getMeta(k: string): string | undefined {
    return (this.db.prepare(`SELECT v FROM meta WHERE k = ?`).get(k) as { v: string } | undefined)?.v;
  }

  setMeta(k: string, v: string): void {
    this.db.prepare(`INSERT INTO meta VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, v);
  }

  static tokens = tokens;
}
