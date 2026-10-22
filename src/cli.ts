#!/usr/bin/env node
import { openEngine } from './index.js';

const USAGE = `code-index — structural code index for AI agents

Usage: code-index <command> [args] [--root DIR] [--budget N]

  init [--yes]                interactive setup: plugins, excludes, aliases, budgets,
                              tools, MCP clients (Claude Code, Cursor, VS Code, Codex)
  index                       build / refresh the index (incremental)
  map [path] [--depth N]      directory tree with key symbols, central files first
  outline <file> [--match S]  every symbol in a file, signatures + line ranges
  symbol <name> [--full]      source of one symbol (class -> member outline)
  refs <name> [--out] [--kinds a,b]   who uses it (or, with --out, what it uses)
  search <query> [--kind K]   ranked symbol search (camelCase-aware)
  stats                       counts per language / kind
  mcp                         run the MCP server on stdio`;

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) pos.push(a);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  }
  return { pos, flags };
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = pos;
  if (!cmd || flags.help) return console.log(USAGE);

  if (cmd === 'init') {
    const { runInit } = await import('./init.js');
    return runInit(typeof flags.root === 'string' ? flags.root : undefined, !!flags.yes);
  }

  if (cmd === 'mcp') {
    const { runMcp } = await import('./mcp.js');
    return runMcp(typeof flags.root === 'string' ? flags.root : undefined);
  }

  const e = await openEngine(typeof flags.root === 'string' ? flags.root : undefined);
  const stats = await e.indexer.indexAll((m) => process.stderr.write(m + '\n'));
  const budget = typeof flags.budget === 'string' ? Number(flags.budget) : undefined;
  const arg = rest.join(' ');

  switch (cmd) {
    case 'index':
      console.log(`${e.root}: ${stats.scanned} files, ${stats.updated} updated, ${stats.removed} removed in ${stats.ms}ms`);
      console.log(e.query.stats());
      break;
    case 'map':
      console.log(e.query.repoMap(arg, flags.depth ? Number(flags.depth) : 2, budget));
      break;
    case 'outline':
      console.log(e.query.outline(arg, { match: flags.match as string | undefined, budget }));
      break;
    case 'symbol':
      console.log(e.query.symbol(arg, { full: !!flags.full, budget }));
      break;
    case 'refs':
      console.log(e.query.refs(arg, {
        direction: flags.out ? 'out' : 'in',
        kinds: typeof flags.kinds === 'string' ? flags.kinds.split(',') : undefined,
        budget,
      }));
      break;
    case 'search':
      console.log(e.query.search(arg, { kind: flags.kind as string | undefined, budget }));
      break;
    case 'stats':
      console.log(e.query.stats());
      break;
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
