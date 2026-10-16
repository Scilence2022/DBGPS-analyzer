// Signed adjacent fold change along a k-mer coverage profile.
//
// The kernel reports an unsigned larger/smaller ratio per edge and encodes any
// edge touching zero coverage as 0, which reads as "no change" on a plot. For
// display we derive a signed log2 change from the coverages themselves: a drop
// is negative, a rise positive, and edges into or out of zero coverage are
// flagged instead of being given a made-up finite value.

export type FoldEdge = {
  // Edge i joins k-mer windows i and i + 1.
  edge: number;
  from: number;
  to: number;
  kind: "change" | "to-zero" | "from-zero" | "both-zero";
  // log2(to / from) for "change"; null otherwise.
  log2: number | null;
};

export function adjacentFoldChanges(coverages: number[]): FoldEdge[] {
  const edges: FoldEdge[] = [];
  for (let i = 0; i + 1 < coverages.length; i++) {
    const from = Math.max(0, Number(coverages[i]) || 0);
    const to = Math.max(0, Number(coverages[i + 1]) || 0);
    if (from > 0 && to > 0) edges.push({ edge: i, from, to, kind: "change", log2: Math.log2(to / from) });
    else if (from > 0) edges.push({ edge: i, from, to, kind: "to-zero", log2: null });
    else if (to > 0) edges.push({ edge: i, from, to, kind: "from-zero", log2: null });
    else edges.push({ edge: i, from, to, kind: "both-zero", log2: null });
  }
  return edges;
}

// Symmetric axis limit in whole log2 units: at least 1 (so the ±2-fold guides
// are always on scale), at most `maxCap` so one extreme edge cannot flatten the
// rest. Finite changes beyond the cap are drawn clipped at it.
export function foldAxisCap(edges: FoldEdge[], maxCap = 6): number {
  let peak = 0;
  for (const edge of edges) if (edge.log2 != null) peak = Math.max(peak, Math.abs(edge.log2));
  return Math.min(maxCap, Math.max(1, Math.ceil(peak - 1e-9)));
}

// Linear fold for a log2 value: 2.0×, 0.50×, 1.0×.
export function formatFold(log2: number): string {
  const fold = 2 ** log2;
  if (fold >= 10) return `${fold.toFixed(0)}×`;
  if (fold >= 1) return `${fold.toFixed(1)}×`;
  return `${fold.toFixed(fold >= 0.1 ? 2 : 3)}×`;
}

export function formatLog2(log2: number): string {
  const rounded = Math.abs(log2) < 0.005 ? 0 : log2;
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : ""}${Math.abs(rounded).toFixed(2)}`;
}

export function describeFoldEdge(edge: FoldEdge): string {
  const span = `windows ${edge.edge}→${edge.edge + 1}: ${edge.from} → ${edge.to}`;
  switch (edge.kind) {
    case "change":
      return `${span} (log₂ ${formatLog2(edge.log2!)}, ${formatFold(edge.log2!)})`;
    case "to-zero":
      return `${span} (drops to zero coverage)`;
    case "from-zero":
      return `${span} (recovers from zero coverage)`;
    default:
      return `${span} (both unsupported)`;
  }
}
