import * as p from '@clack/prompts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, Indexer, loadConfig, type IndexConfig } from './core/indexer.js';
import { Store } from './core/store.js';
import { isLanguagePlugin } from './core/types.js';
import { ALL_TOOLS } from './mcp.js';
import { BUILTIN_PLUGINS, dbPathFor, openEngine } from './index.js';
import type { TypeScriptPlugin } from './plugins/typescript/index.js';

const CONFIG_FILE = '.codeindex.json';
const PACKAGE_NAME = (
  JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { name: string }
).name;
const SERVER_NAME = 'code-index';
const NOISY = /(^|\/)(migrations?|tests?|__tests__|__mocks__|fixtures|stories|coverage|generated|public|static|assets|web\/js|web\/css|\.next|out)$/;

const BUDGET_PRESETS = {
  lean: { map: 800, outline: 1200, symbol: 2500, refs: 1200, search: 800 },
  balanced: { map: 1500, outline: 2000, symbol: 4000, refs: 2000, search: 1500 },
  generous: { map: 3000, outline: 4000, symbol: 8000, refs: 4000, search: 3000 },
} as const;

const AGENT_HINT = `<!-- code-index:start -->
## Code navigation (code-index MCP)

Before reading whole files, use the \`code-index\` MCP tools: \`code_map\` to orient,
\`code_search\` / \`code_outline\` to find a symbol, \`code_symbol\` to read only that code,
and \`code_refs\` to see who depends on it before changing it. Read a full file only when
you will edit most of it.
<!-- code-index:end -->`;

function bail<T>(v: T | symbol): T {
  if (p.isCancel(v)) {
    p.cancel('Cancelled — nothing written.');
    process.exit(0);
  }
  return v as T;
}

const readJson = (file: string): Record<string, any> => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

interface Launch {
  command: string;
  args: string[];
}

/** Count indexable files per top directory (and noisy second-level ones) to suggest excludes. */
function dirSuggestions(files: string[]): { path: string; count: number; noisy: boolean }[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const parts = f.split('/');
    for (let depth = 1; depth <= Math.min(3, parts.length - 1); depth++) {
      const d = parts.slice(0, depth).join('/');
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([d]) => !d.includes('/') || NOISY.test(d))
    .map(([path, count]) => ({ path, count, noisy: NOISY.test(path) }))
    .sort((a, b) => Number(b.noisy) - Number(a.noisy) || b.count - a.count)
    .slice(0, 30);
}

export async function runInit(rootArg: string | undefined, yes: boolean): Promise<void> {
  const root = resolve(rootArg ?? process.cwd());
  const existing = loadConfig(root);
  const hadConfig = existsSync(join(root, CONFIG_FILE));

  p.intro(`code-index init — ${root}`);
  const spin = p.spinner();
  spin.start('Scanning the repo');

  // Probe with every built-in plugin to show what is present.
  const probe = new Indexer(root, new Store(':memory:'), BUILTIN_PLUGINS, { ...DEFAULT_CONFIG, pluginOptions: existing.pluginOptions });
  await probe.init();
  const files = probe.listFiles();
  const langCount = new Map<string, number>();
  for (const f of files) {
    const id = probe.langFor(f)!.id;
    langCount.set(id, (langCount.get(id) ?? 0) + 1);
  }
  const detected = new Set(probe.activePlugins());
  spin.stop(`Found ${files.length} source files`);

  // 1. Plugins
  const pluginOptions = BUILTIN_PLUGINS.map((pl) => {
    const lang = isLanguagePlugin(pl);
    const hint = lang
      ? `${langCount.get(pl.id) ?? 0} files`
      : detected.has(pl.id) ? 'detected' : `not detected (needs ${pl.dependsOn.join(', ')})`;
    return { value: pl.id, label: `${pl.id}${lang ? '' : '  (framework)'}`, hint };
  });
  const initialPlugins = existing.enable?.length
    ? existing.enable
    : BUILTIN_PLUGINS.filter((pl) => (isLanguagePlugin(pl) ? (langCount.get(pl.id) ?? 0) > 0 : detected.has(pl.id))).map((pl) => pl.id);

  const enable = yes
    ? initialPlugins
    : bail(await p.multiselect({ message: 'Which plugins should run?', options: pluginOptions, initialValues: initialPlugins, required: true }));

  // 2. Excludes
  const suggestions = dirSuggestions(files);
  const userExcludes = existing.exclude.filter((e) => !DEFAULT_CONFIG.exclude.includes(e)).map((e) => e.replace(/\/$/, ''));
  const initialExcludes = hadConfig ? userExcludes : suggestions.filter((s) => s.noisy).map((s) => s.path);
  let exclude = initialExcludes;
  if (!yes) {
    exclude = bail(await p.multiselect({
      message: `Exclude directories? (always skipped: ${DEFAULT_CONFIG.exclude.join(' ')})`,
      options: [...new Set([...suggestions.map((s) => s.path), ...userExcludes])].map((path) => {
        const s = suggestions.find((x) => x.path === path);
        return { value: path, label: path, hint: s ? `${s.count} files${s.noisy ? ', usually noise' : ''}` : 'from config' };
      }),
      initialValues: initialExcludes,
      required: false,
    }));
    const more = bail(await p.text({ message: 'Other path prefixes to exclude (comma separated, optional)', placeholder: 'e.g. legacy/, scripts/tmp', defaultValue: '' }));
    exclude = [...exclude, ...more.split(',').map((s) => s.trim()).filter(Boolean)];
  }

  // 3. TS path aliases
  const options: Record<string, Record<string, unknown>> = { ...(existing.pluginOptions ?? {}) };
  if (enable.includes('typescript') && !yes) {
    const ts = BUILTIN_PLUGINS.find((pl) => pl.id === 'typescript') as unknown as TypeScriptPlugin;
    const found = ts.pathAliases.map((a) => `${a.prefix} → ${a.targets[0]}`);
    p.note(found.length ? found.join('\n') : 'none found in tsconfig/jsconfig', 'TypeScript path aliases');
    const current = (options.typescript?.aliases ?? {}) as Record<string, string>;
    const extra = bail(await p.text({
      message: 'Extra import aliases (prefix=dir, comma separated; for aliases defined in vite/webpack config)',
      placeholder: '@hooks/=src/hooks/, @i18n/=src/i18n/',
      defaultValue: Object.entries(current).map(([k, v]) => `${k}=${v}`).join(', '),
      initialValue: Object.entries(current).map(([k, v]) => `${k}=${v}`).join(', '),
    }));
    const aliases = Object.fromEntries(
      extra.split(',').map((s) => s.trim().split('=').map((x) => x.trim())).filter((kv) => kv.length === 2 && kv[0] && kv[1]),
    );
    options.typescript = { ...(options.typescript ?? {}), aliases };
    if (!Object.keys(aliases).length) delete options.typescript.aliases;
    if (!Object.keys(options.typescript).length) delete options.typescript;
  }

  // 4. Budgets
  let budgets: IndexConfig['budgets'] = existing.budgets;
  if (!yes) {
    const preset = bail(await p.select({
      message: 'Output token budgets (max tokens per tool answer)',
      options: [
        { value: 'balanced', label: 'Balanced', hint: 'map 1500 · outline 2000 · symbol 4000' },
        { value: 'lean', label: 'Lean', hint: 'map 800 · outline 1200 · symbol 2500 — fewest tokens' },
        { value: 'generous', label: 'Generous', hint: 'map 3000 · outline 4000 · symbol 8000 — fewer follow-up calls' },
        { value: 'custom', label: 'Custom' },
      ],
      initialValue: 'balanced',
    }));
    if (preset === 'custom') {
      budgets = {};
      for (const k of Object.keys(BUDGET_PRESETS.balanced) as (keyof typeof BUDGET_PRESETS.balanced)[]) {
        const v = bail(await p.text({
          message: `${k} budget`,
          defaultValue: String(existing.budgets?.[k] ?? BUDGET_PRESETS.balanced[k]),
          placeholder: String(existing.budgets?.[k] ?? BUDGET_PRESETS.balanced[k]),
          validate: (x) => (x && !/^\d+$/.test(x) ? 'a number' : undefined),
        }));
        budgets[k] = Number(v);
      }
    } else budgets = preset === 'balanced' ? undefined : { ...BUDGET_PRESETS[preset as keyof typeof BUDGET_PRESETS] };
  }

  // 5. Tools
  const tools = yes
    ? existing.tools
    : bail(await p.multiselect({
        message: 'MCP tools to expose',
        options: ALL_TOOLS.map((t) => ({ value: t as string, label: t })),
        initialValues: existing.tools ?? [...ALL_TOOLS],
        required: true,
      }));

  // 6. MCP clients
  const clients = yes
    ? []
    : bail(await p.multiselect({
        message: 'Register the MCP server with (space to toggle, none is fine)',
        options: [
          { value: 'claude-project', label: 'Claude Code — this project', hint: '.mcp.json (commit it to share)' },
          { value: 'claude-user', label: 'Claude Code — all my projects', hint: 'runs `claude mcp add -s user`' },
          { value: 'cursor', label: 'Cursor', hint: '.cursor/mcp.json' },
          { value: 'vscode', label: 'VS Code / Copilot', hint: '.vscode/mcp.json' },
          { value: 'codex', label: 'Codex CLI', hint: '~/.codex/config.toml (this repo only)' },
        ],
        required: false,
      }));

  let launch: Launch | null = null;
  if (clients.length) {
    const localCli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
    const how = bail(await p.select({
      message: 'How should clients start the server?',
      options: [
        { value: 'npm', label: `npx ${PACKAGE_NAME}`, hint: 'shareable; always the published version' },
        { value: 'local', label: 'From this checkout', hint: `node ${localCli} — personal setups` },
        { value: 'git', label: 'npx from a git URL', hint: 'shareable; teammates need repo access' },
        { value: 'global', label: 'Global binary `code-index`', hint: 'after `npm i -g` / `npm link`' },
      ],
    }));
    if (how === 'npm') {
      launch = { command: 'npx', args: ['-y', PACKAGE_NAME, 'mcp'] };
    } else if (how === 'local') {
      if (!existsSync(localCli)) p.log.warn(`${localCli} does not exist yet — run \`npm run build\` in the code-index repo.`);
      launch = { command: 'node', args: [localCli, 'mcp'] };
    } else if (how === 'git') {
      const url = bail(await p.text({
        message: 'Git URL (pin a tag with #vX.Y.Z)',
        placeholder: 'git+ssh://git@github.com/you/code-index.git#v0.2.0',
        validate: (x) => (x ? undefined : 'required'),
      }));
      launch = { command: 'npx', args: ['-y', url, 'mcp'] };
    } else launch = { command: 'code-index', args: ['mcp'] };
  }

  // 7. Agent instructions
  const hintTargets = yes
    ? []
    : bail(await p.multiselect({
        message: 'Tell agents to prefer these tools? (appends a short block, idempotent)',
        options: [
          { value: 'AGENTS.md', label: 'AGENTS.md', hint: existsSync(join(root, 'AGENTS.md')) ? 'exists' : 'new file' },
          { value: 'CLAUDE.md', label: 'CLAUDE.md', hint: existsSync(join(root, 'CLAUDE.md')) ? 'exists' : 'new file' },
          { value: '.cursor/rules/code-index.mdc', label: '.cursor/rules/code-index.mdc' },
        ],
        required: false,
      }));

  // Build the config: only what differs from defaults.
  const config: Partial<IndexConfig> = {};
  const allIds = BUILTIN_PLUGINS.map((pl) => pl.id);
  if (enable.length && enable.length !== allIds.length) config.enable = enable;
  if (exclude.length) config.exclude = exclude.map((e) => (e.endsWith('/') ? e : e + '/'));
  if (Object.keys(options).length) config.pluginOptions = options;
  if (budgets) config.budgets = budgets;
  if (tools && tools.length !== ALL_TOOLS.length) config.tools = tools;
  if (existing.plugins.length) config.plugins = existing.plugins;

  const actions: string[] = [`write ${CONFIG_FILE}`];
  for (const c of clients) actions.push(`register MCP: ${c}`);
  for (const h of hintTargets) actions.push(`agent hint → ${h}`);
  p.note(`${JSON.stringify(config, null, 2)}\n\n${actions.map((a) => '• ' + a).join('\n')}`, 'Summary');

  if (!yes && !bail(await p.confirm({ message: 'Write these changes?' }))) {
    p.cancel('Nothing written.');
    return;
  }

  writeJson(join(root, CONFIG_FILE), config);
  if (launch) for (const c of clients) registerClient(c, root, launch);
  for (const h of hintTargets) appendHint(join(root, h), h.endsWith('.mdc'));

  const runIndex = yes || bail(await p.confirm({ message: 'Build the index now?', initialValue: true }));
  if (runIndex) {
    spin.start('Indexing');
    const e = await openEngine(root);
    const s = await e.indexer.indexAll();
    spin.stop(`Indexed ${s.scanned} files in ${s.ms}ms (plugins: ${e.indexer.activePlugins().join(', ')})`);
    p.log.info(`Index: ${dbPathFor(root)}`);
  }
  p.outro('Done. Try: code-index map --depth 2');
}

function registerClient(client: string, root: string, launch: Launch): void {
  const entry = { command: launch.command, args: launch.args };
  switch (client) {
    case 'claude-project': {
      const file = join(root, '.mcp.json');
      const data = readJson(file);
      data.mcpServers = { ...(data.mcpServers ?? {}), [SERVER_NAME]: entry };
      writeJson(file, data);
      p.log.success('.mcp.json updated');
      break;
    }
    case 'claude-user':
      try {
        execFileSync('claude', ['mcp', 'remove', '-s', 'user', SERVER_NAME], { stdio: 'ignore' });
      } catch {
        /* not registered yet */
      }
      try {
        execFileSync('claude', ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', launch.command, ...launch.args], { stdio: 'ignore' });
        p.log.success('Registered with Claude Code (user scope)');
      } catch {
        p.log.warn(`\`claude\` CLI not found. Run: claude mcp add -s user ${SERVER_NAME} -- ${launch.command} ${launch.args.join(' ')}`);
      }
      break;
    case 'cursor': {
      const file = join(root, '.cursor', 'mcp.json');
      const data = readJson(file);
      data.mcpServers = { ...(data.mcpServers ?? {}), [SERVER_NAME]: { ...entry, args: [...entry.args, '--root', '${workspaceFolder}'] } };
      writeJson(file, data);
      p.log.success('.cursor/mcp.json updated');
      break;
    }
    case 'vscode': {
      const file = join(root, '.vscode', 'mcp.json');
      const data = readJson(file);
      data.servers = { ...(data.servers ?? {}), [SERVER_NAME]: { type: 'stdio', ...entry, args: [...entry.args, '--root', '${workspaceFolder}'] } };
      writeJson(file, data);
      p.log.success('.vscode/mcp.json updated');
      break;
    }
    case 'codex': {
      const file = join(homedir(), '.codex', 'config.toml');
      const q = (s: string) => JSON.stringify(s);
      const block = `[mcp_servers.${SERVER_NAME}]\ncommand = ${q(launch.command)}\nargs = [${[...launch.args, '--root', root].map(q).join(', ')}]\n`;
      const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const re = new RegExp(`\\[mcp_servers\\.${SERVER_NAME}\\][^\\[]*`);
      const next = re.test(prev) ? prev.replace(re, block + '\n') : `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}\n${block}`;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, next);
      p.log.success('~/.codex/config.toml updated');
      break;
    }
  }
}

function appendHint(file: string, mdc: boolean): void {
  const body = mdc ? `---\ndescription: Prefer code-index MCP tools for code navigation\nalwaysApply: true\n---\n${AGENT_HINT}\n` : AGENT_HINT;
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const re = /<!-- code-index:start -->[\s\S]*?<!-- code-index:end -->/;
  const next = mdc ? body : re.test(prev) ? prev.replace(re, AGENT_HINT) : `${prev}${prev ? '\n\n' : ''}${AGENT_HINT}\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  p.log.success(`${file.split('/').slice(-2).join('/')} updated`);
}

