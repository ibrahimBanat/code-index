import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Indexer, loadConfig } from './core/indexer.js';
import { Query } from './core/query.js';
import { Store } from './core/store.js';
import type { Plugin } from './core/types.js';
import nextjs from './plugins/nextjs/index.js';
import php from './plugins/php/index.js';
import typescript from './plugins/typescript/index.js';
import yii2 from './plugins/yii2/index.js';

export * from './core/types.js';
export { Indexer, Query, Store };

export const BUILTIN_PLUGINS: Plugin[] = [php, typescript, yii2, nextjs];

/** Index lives outside the repo so nothing is written into the project tree. Override with CODE_INDEX_DIR. */
export function dbPathFor(root: string): string {
  const dir = process.env.CODE_INDEX_DIR ?? join(homedir(), '.cache', 'code-index');
  const id = createHash('sha1').update(root).digest('hex').slice(0, 12);
  return join(dir, `${root.split('/').pop()}-${id}.db`);
}

export interface Engine {
  root: string;
  store: Store;
  indexer: Indexer;
  query: Query;
}

export async function openEngine(rootArg = process.cwd()): Promise<Engine> {
  const root = resolve(rootArg);
  const config = loadConfig(root);
  const extra: Plugin[] = [];
  for (const spec of config.plugins) {
    const mod = await import(pathToFileURL(resolve(root, spec)).href);
    extra.push(mod.default as Plugin);
  }
  const store = new Store(dbPathFor(root));
  const indexer = new Indexer(root, store, [...BUILTIN_PLUGINS, ...extra], config);
  await indexer.init();
  return { root, store, indexer, query: new Query(store, indexer) };
}
