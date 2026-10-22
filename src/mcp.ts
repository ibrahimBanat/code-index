import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve } from 'node:path';
import { loadConfig } from './core/indexer.js';
import { openEngine, type Engine } from './index.js';

const INSTRUCTIONS = `Structural code index. Prefer these tools over reading whole files:
1. code_map to orient (directory tree + key symbols).
2. code_search / code_outline to find the symbol.
3. code_symbol to read only the code you need.
4. code_refs before changing a symbol, to see who depends on it.
Read a full file only when you will edit most of it.`;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const budget = z.number().int().min(100).max(20000).optional().describe('Max tokens of output');

export const ALL_TOOLS = ['code_map', 'code_outline', 'code_symbol', 'code_refs', 'code_search'] as const;

export async function runMcp(rootArg?: string): Promise<void> {
  const log = (m: string) => process.stderr.write(`[code-index] ${m}\n`);
  const root = resolve(rootArg ?? process.env.CODE_INDEX_ROOT ?? process.cwd());
  const enabled = new Set(loadConfig(root).tools ?? ALL_TOOLS);
  // Start answering immediately; tools wait for the first (incremental) index pass.
  const ready: Promise<Engine> = openEngine(root).then(async (e) => {
    const s = await e.indexer.indexAll(log);
    log(`ready: ${s.scanned} files (${s.updated} re-indexed) in ${s.ms}ms; plugins ${e.indexer.activePlugins().join(', ')}`);
    return e;
  });
  const run = (fn: (e: Engine) => string) => async () => {
    try {
      return text(fn(await ready));
    } catch (err) {
      return { ...text(`error: ${(err as Error).message}`), isError: true };
    }
  };

  const mcp = new McpServer({ name: 'code-index', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  // Only register the tools the repo's .codeindex.json enables.
  const server = {
    registerTool: ((name: string, ...rest: unknown[]) => {
      if (enabled.has(name)) (mcp.registerTool as (...a: unknown[]) => unknown)(name, ...rest);
    }) as McpServer['registerTool'],
  };

  server.registerTool(
    'code_map',
    {
      description: 'Directory tree of the repo (or a subpath) with file counts and each file\'s top-level symbols, most central first. Use first to orient.',
      inputSchema: {
        path: z.string().optional().describe('Repo-relative directory; empty for root'),
        depth: z.number().int().min(1).max(6).optional().describe('Directory levels to expand (default 2)'),
        budget,
      },
    },
    async (a) => run((e) => e.query.repoMap(a.path ?? '', a.depth ?? 2, a.budget))(),
  );

  server.registerTool(
    'code_outline',
    {
      description: 'All symbols in one file as one-line signatures with line ranges (no bodies). Far cheaper than reading the file.',
      inputSchema: {
        file: z.string().describe('Repo-relative file path'),
        match: z.string().optional().describe('Only members whose name contains this'),
        budget,
      },
    },
    async (a) => run((e) => e.query.outline(a.file, { match: a.match, budget: a.budget }))(),
  );

  server.registerTool(
    'code_symbol',
    {
      description: 'Source code of one symbol (method, function, property, relation). For a class returns its member outline unless full=true. Accepts an fqn, Class::method, or a short name.',
      inputSchema: {
        name: z.string().describe('e.g. "common\\\\models\\\\Car::getOwner", "Car::getOwner", or "getOwner"'),
        full: z.boolean().optional().describe('For classes: return full source instead of outline'),
        budget,
      },
    },
    async (a) => run((e) => e.query.symbol(a.name, { full: a.full, budget: a.budget }))(),
  );

  server.registerTool(
    'code_refs',
    {
      description: 'Graph neighbours of a symbol. direction "in": callers, subclasses, implementers, dispatchers, routes. "out": what it calls, extends, dispatches. Edge kinds include calls, extends, implements, instantiates, references, dispatches, relation, uses_component, handled_by, guarded_by.',
      inputSchema: {
        name: z.string(),
        direction: z.enum(['in', 'out']).optional(),
        kinds: z.array(z.string()).optional().describe('Only these edge kinds'),
        budget,
      },
    },
    async (a) => run((e) => e.query.refs(a.name, { direction: a.direction, kinds: a.kinds, budget: a.budget }))(),
  );

  server.registerTool(
    'code_search',
    {
      description: 'Ranked search over symbol names, fqns and doc summaries. camelCase-aware ("owner car" finds getOwnerCar). Optional kind filter: class, method, function, property, const, relation, route, component.',
      inputSchema: {
        query: z.string(),
        kind: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        budget,
      },
    },
    async (a) => run((e) => e.query.search(a.query, { kind: a.kind, limit: a.limit, budget: a.budget }))(),
  );

  await mcp.connect(new StdioServerTransport());
  log('MCP server on stdio');
}
