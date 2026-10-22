/**
 * Token comparison: reading whole files vs. outline vs. one symbol.
 * Usage: npx tsx scripts/bench.ts <root> <file>[::<symbol>] ...
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateTokens } from '../src/core/query.js';
import { openEngine } from '../src/index.js';

const [root, ...targets] = process.argv.slice(2);
const e = await openEngine(root);
await e.indexer.indexAll();
const rows: string[][] = [['target', 'whole file', 'outline', 'symbol', 'saved']];
for (const t of targets) {
  const [file, sym] = t.split('::');
  const whole = estimateTokens(readFileSync(join(e.root, file), 'utf8'));
  const outline = estimateTokens(e.query.outline(file, { budget: 1e6 }));
  const symbol = sym ? estimateTokens(e.query.symbol(`${file.split('/').pop()!.replace(/\.\w+$/, '')}::${sym}`, { budget: 1e6 })) : 0;
  const used = sym ? outline + symbol : outline;
  rows.push([t, String(whole), String(outline), sym ? String(symbol) : '-', `${Math.round(100 - (100 * used) / whole)}%`]);
}
const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join('  '));
