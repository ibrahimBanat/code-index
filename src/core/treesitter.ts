import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import Parser from 'web-tree-sitter';

const require = createRequire(import.meta.url);
let ready: Promise<void> | null = null;

/** Load a grammar bundled in `tree-sitter-wasms` (e.g. "php", "go", "typescript"). */
export async function loadGrammar(name: string): Promise<Parser> {
  ready ??= Parser.init();
  await ready;
  const dir = join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
  const lang = await Parser.Language.load(join(dir, `tree-sitter-${name}.wasm`));
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

export type Node = Parser.SyntaxNode;

/** Depth-first walk. Return false from visit to skip a subtree. */
export function walk(node: Node, visit: (n: Node) => boolean | void): void {
  if (visit(node) === false) return;
  for (const child of node.namedChildren) walk(child, visit);
}

export function oneLine(text: string, max = 300): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** First sentence of a /** doc comment, without tags. */
export function docSummary(comment: string, max = 140): string | undefined {
  const lines = comment
    .replace(/^\/\*\*|\*\/$/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter((l) => l && !l.startsWith('@'));
  if (!lines.length) return undefined;
  const text = lines.join(' ');
  const sentence = text.match(/^.*?[.!?](\s|$)/)?.[0] ?? text;
  return oneLine(sentence, max);
}
