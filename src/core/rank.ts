/**
 * PageRank over the file dependency graph. A file that many files depend on
 * ranks high, so maps and search results list central code first.
 * Scores are normalised so the top file is 1.
 */
export function pageRank(
  nodes: string[],
  edges: { src: string; dst: string }[],
  damping = 0.85,
  iterations = 30,
): Map<string, number> {
  const n = nodes.length;
  const rank = new Map<string, number>();
  if (!n) return rank;

  const out = new Map<string, string[]>();
  for (const { src, dst } of edges) {
    if (!out.has(src)) out.set(src, []);
    out.get(src)!.push(dst);
  }
  for (const node of nodes) rank.set(node, 1 / n);

  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const node of nodes) {
      next.set(node, (1 - damping) / n);
      if (!out.get(node)?.length) dangling += rank.get(node)!;
    }
    for (const [src, dsts] of out) {
      const share = (damping * (rank.get(src) ?? 0)) / dsts.length;
      for (const d of dsts) if (next.has(d)) next.set(d, next.get(d)! + share);
    }
    for (const node of nodes) next.set(node, next.get(node)! + (damping * dangling) / n);
    for (const [k, v] of next) rank.set(k, v);
  }

  const max = Math.max(...rank.values());
  for (const [k, v] of rank) rank.set(k, v / max);
  return rank;
}
