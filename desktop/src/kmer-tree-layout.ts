// Geometry for the k-mer branch graph. Kept pure so it is unit-tested in Node and
// bundled into the renderer as-is.
//
// Every step gets one column, so a base's position along the sequence can be read
// straight off the graph. The heaviest branch stays in line with its parent, which
// turns the dominant path into a straight trunk; lighter branches peel off either
// side of it, packed per column so a subtree only claims the height it needs.

export type TreeSide = "upstream" | "downstream";

export type TreeInputNode = {
  base: string;
  kmer: string;
  coverage: number;
  children?: TreeInputNode[];
  exhausted?: boolean;
};

export type TreeBox = { width: number; height: number };

export type TreeLayoutOptions = {
  center: TreeBox;
  nodeBox: (node: TreeInputNode) => TreeBox;
  columnGap: number;
  rowGap: number;
  // Diameter of the "search one more step" button that follows an open leaf.
  expanderSize: number;
  // Width reserved for the "no branches" note on a side with nothing to draw.
  emptyWidth: number;
  padding: number;
};

export type PlacedTreeNode = {
  key: string;
  parentKey: string | null;
  side: TreeSide;
  // Index path into the original tree, which layout ordering does not change.
  path: string;
  step: number;
  base: string;
  kmer: string;
  coverage: number;
  exhausted: boolean;
  expandable: boolean;
  // On the heaviest chain from the query.
  main: boolean;
  // Fraction of the fork's coverage; null where the parent does not branch.
  share: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
};

export type PlacedExpander = {
  key: string;
  side: TreeSide;
  path: string;
  kmer: string;
  x: number;
  y: number;
  fromX: number;
};

export type TreeColumn = { side: TreeSide; step: number; x: number };

export type TreeLayout = {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  nodes: PlacedTreeNode[];
  expanders: PlacedExpander[];
  columns: TreeColumn[];
  empty: Array<{ side: TreeSide; x: number; y: number }>;
};

export type TreePathSummary = {
  prefix: string;
  query: string;
  suffix: string;
  sequence: string;
  upstreamSteps: number;
  downstreamSteps: number;
  minCoverage: number | null;
  forks: number;
  end: PlacedTreeNode | null;
};

type Draft = {
  input: TreeInputNode;
  path: string;
  box: TreeBox;
  main: boolean;
  share: number | null;
  expandable: boolean;
  offset: number;
  children: Draft[];
};

// Extent above and below a subtree's root, indexed by column.
type Contour = { up: number[]; down: number[] };

function buildDrafts(nodes: TreeInputNode[] | undefined, options: TreeLayoutOptions, onMainChain: boolean, pathPrefix = ""): Draft[] {
  const entries = (nodes ?? []).map((input, index) => ({ input, path: pathPrefix ? `${pathPrefix}.${index}` : String(index) }));
  const total = entries.reduce((sum, entry) => sum + entry.input.coverage, 0);
  return entries
    .sort((a, b) => b.input.coverage - a.input.coverage)
    .map((entry, index) => {
      const main = onMainChain && index === 0;
      const children = buildDrafts(entry.input.children, options, main, entry.path);
      return {
        input: entry.input,
        path: entry.path,
        box: options.nodeBox(entry.input),
        main,
        share: entries.length > 1 && total > 0 ? entry.input.coverage / total : null,
        expandable: children.length === 0 && !entry.input.exhausted,
        offset: 0,
        children
      };
    });
}

function contourOf(draft: Draft, options: TreeLayoutOptions): Contour {
  const half = draft.box.height / 2;
  const contour: Contour = { up: [half], down: [half] };
  if (draft.children.length > 0) {
    const below = stackSiblings(draft.children, options);
    contour.up.push(...below.up);
    contour.down.push(...below.down);
  } else if (draft.expandable) {
    contour.up.push(options.expanderSize / 2);
    contour.down.push(options.expanderSize / 2);
  }
  return contour;
}

// Keeps the first sibling on the parent's line and alternates the rest below and
// above it, each pushed out only as far as the columns it shares with the others.
function stackSiblings(drafts: Draft[], options: TreeLayoutOptions): Contour {
  const merged: Contour = { up: [], down: [] };
  drafts.forEach((draft, index) => {
    const contour = contourOf(draft, options);
    const shared = Math.min(merged.up.length, contour.up.length);
    let clearance = 0;
    for (let column = 0; column < shared; column += 1) {
      const facing = index % 2 === 1 ? merged.down[column] + contour.up[column] : merged.up[column] + contour.down[column];
      clearance = Math.max(clearance, facing + options.rowGap);
    }
    draft.offset = index === 0 ? 0 : index % 2 === 1 ? clearance : -clearance;
    for (let column = 0; column < contour.up.length; column += 1) {
      const up = contour.up[column] - draft.offset;
      const down = contour.down[column] + draft.offset;
      merged.up[column] = column < merged.up.length ? Math.max(merged.up[column], up) : up;
      merged.down[column] = column < merged.down.length ? Math.max(merged.down[column], down) : down;
    }
  });
  return merged;
}

function measureColumns(drafts: Draft[], options: TreeLayoutOptions, widths: number[], depth = 0) {
  for (const draft of drafts) {
    widths[depth] = Math.max(widths[depth] ?? 0, draft.box.width);
    if (draft.expandable) widths[depth + 1] = Math.max(widths[depth + 1] ?? 0, options.expanderSize);
    measureColumns(draft.children, options, widths, depth + 1);
  }
}

function placeSide(side: TreeSide, roots: Draft[], options: TreeLayoutOptions, layout: TreeLayout) {
  const direction = side === "downstream" ? 1 : -1;
  const edge = (direction * options.center.width) / 2;
  if (roots.length === 0) {
    layout.empty.push({ side, x: edge + (direction * (options.columnGap + options.emptyWidth)) / 2, y: 0 });
    return;
  }

  stackSiblings(roots, options);
  const widths: number[] = [];
  measureColumns(roots, options, widths);
  const columnCenters: number[] = [];
  let cursor = edge;
  widths.forEach((width, index) => {
    columnCenters.push(cursor + direction * (options.columnGap + width / 2));
    cursor += direction * (options.columnGap + width);
    layout.columns.push({ side, step: index + 1, x: columnCenters[index] });
  });

  const place = (draft: Draft, depth: number, parentKey: string | null, parentY: number, fromX: number) => {
    const key = `${side}:${draft.path}`;
    const x = columnCenters[depth];
    const y = parentY + draft.offset;
    const halfWidth = draft.box.width / 2;
    layout.nodes.push({
      key,
      parentKey,
      side,
      path: draft.path,
      step: depth + 1,
      base: draft.input.base,
      kmer: draft.input.kmer,
      coverage: draft.input.coverage,
      exhausted: Boolean(draft.input.exhausted),
      expandable: draft.expandable,
      main: draft.main,
      share: draft.share,
      x,
      y,
      width: draft.box.width,
      height: draft.box.height,
      fromX,
      fromY: parentY,
      toX: x - direction * halfWidth,
      toY: y
    });
    const outerX = x + direction * halfWidth;
    if (draft.expandable) {
      layout.expanders.push({ key, side, path: draft.path, kmer: draft.input.kmer, x: columnCenters[depth + 1], y, fromX: outerX });
    }
    for (const child of draft.children) place(child, depth + 1, key, y, outerX);
  };
  for (const root of roots) place(root, 0, null, 0, edge);
}

function shiftLayout(layout: TreeLayout, dx: number, dy: number) {
  layout.centerX += dx;
  layout.centerY += dy;
  for (const node of layout.nodes) {
    node.x += dx;
    node.y += dy;
    node.fromX += dx;
    node.fromY += dy;
    node.toX += dx;
    node.toY += dy;
  }
  for (const expander of layout.expanders) {
    expander.x += dx;
    expander.y += dy;
    expander.fromX += dx;
  }
  for (const column of layout.columns) column.x += dx;
  for (const note of layout.empty) {
    note.x += dx;
    note.y += dy;
  }
}

export function layoutKmerTree(upstream: TreeInputNode[] | undefined, downstream: TreeInputNode[] | undefined, options: TreeLayoutOptions): TreeLayout {
  const layout: TreeLayout = { width: 0, height: 0, centerX: 0, centerY: 0, nodes: [], expanders: [], columns: [], empty: [] };
  placeSide("upstream", buildDrafts(upstream, options, true), options, layout);
  placeSide("downstream", buildDrafts(downstream, options, true), options, layout);

  let left = -options.center.width / 2;
  let right = options.center.width / 2;
  let top = -options.center.height / 2;
  let bottom = options.center.height / 2;
  const include = (x: number, y: number, width: number, height: number) => {
    left = Math.min(left, x - width / 2);
    right = Math.max(right, x + width / 2);
    top = Math.min(top, y - height / 2);
    bottom = Math.max(bottom, y + height / 2);
  };
  for (const node of layout.nodes) include(node.x, node.y, node.width, node.height);
  for (const expander of layout.expanders) include(expander.x, expander.y, options.expanderSize, options.expanderSize);
  for (const note of layout.empty) include(note.x, note.y, options.emptyWidth, 0);

  shiftLayout(layout, options.padding - left, options.padding - top);
  layout.width = Math.ceil(right - left + options.padding * 2);
  layout.height = Math.ceil(bottom - top + options.padding * 2);
  return layout;
}

// "downstream:0.1.2" -> the keys of the nodes from the query out to that node.
export function pathKeys(key: string): string[] {
  const separator = key.indexOf(":");
  const side = key.slice(0, separator);
  const parts = key.slice(separator + 1).split(".");
  return parts.map((_, index) => `${side}:${parts.slice(0, index + 1).join(".")}`);
}

// Spells out one path, or the main path through the query when key is null.
export function summarizeTreePath(layout: TreeLayout, query: string, key: string | null): TreePathSummary {
  const chain = key
    ? pathKeys(key).flatMap((pathKey) => layout.nodes.filter((node) => node.key === pathKey))
    : layout.nodes.filter((node) => node.main);
  const bases = (side: TreeSide) => chain.filter((node) => node.side === side).sort((a, b) => a.step - b.step).map((node) => node.base);
  const upstream = bases("upstream");
  const downstream = bases("downstream");
  const prefix = [...upstream].reverse().join("");
  const suffix = downstream.join("");
  return {
    prefix,
    query,
    suffix,
    sequence: `${prefix}${query}${suffix}`,
    upstreamSteps: upstream.length,
    downstreamSteps: downstream.length,
    minCoverage: chain.length > 0 ? Math.min(...chain.map((node) => node.coverage)) : null,
    forks: chain.filter((node) => node.share !== null).length,
    end: key ? chain[chain.length - 1] ?? null : null
  };
}

// Coverage is drawn by area, so both scales take the square root: the trunk reads
// as dominant without flattening the 1-vs-6 difference that separates noise branches.
export function scaleByCoverage(coverage: number, maxCoverage: number, min: number, max: number) {
  if (maxCoverage <= 0 || coverage <= 0) return min;
  return min + (max - min) * Math.sqrt(Math.min(1, coverage / maxCoverage));
}

export function formatShare(share: number) {
  const percent = share * 100;
  if (percent > 0 && percent < 1) return "<1%";
  if (percent > 99 && percent < 100) return ">99%";
  return `${Math.round(percent)}%`;
}

// Fits a coverage inside the smallest node; the readout carries the exact value.
export function formatCompactCoverage(coverage: number) {
  if (coverage < 1000) return String(coverage);
  const [divisor, suffix] = coverage < 999_500 ? [1000, "k"] : [1_000_000, "M"];
  const scaled = coverage / divisor;
  return `${scaled < 9.95 ? scaled.toFixed(1).replace(/\.0$/, "") : Math.round(scaled)}${suffix}`;
}
