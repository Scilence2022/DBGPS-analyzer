const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  formatCompactCoverage,
  formatShare,
  layoutKmerTree,
  pathKeys,
  scaleByCoverage,
  summarizeTreePath
} = require("../dist/kmer-tree-layout.js");

const options = {
  center: { width: 200, height: 56 },
  nodeBox: (node) => ({ width: node.coverage > 10 ? 60 : 34, height: node.coverage > 10 ? 60 : 34 }),
  columnGap: 40,
  rowGap: 10,
  expanderSize: 26,
  emptyWidth: 130,
  padding: 18
};

const branch = (base, coverage, children = [], extra = {}) => ({ base, kmer: `kmer${base}${coverage}`, coverage, children, ...extra });

// The fork from the reported screenshot: 140 splits into 132 + 6 + 2, each forking again.
const downstream = [
  branch("A", 6, [branch("A", 5, [branch("G", 5)]), branch("G", 1, [branch("A", 1)])]),
  branch("G", 132, [branch("A", 132, [branch("G", 130), branch("C", 2)]), branch("T", 2, [branch("G", 2)])]),
  branch("T", 2, [branch("A", 2, [branch("G", 2)])])
];
const upstream = [branch("T", 137, [branch("A", 137)])];

function byKey(layout) {
  return new Map(layout.nodes.map((node) => [node.key, node]));
}

function assertNoOverlap(boxes) {
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const [a, b] = [boxes[i], boxes[j]];
      const separated =
        Math.abs(a.x - b.x) >= (a.width + b.width) / 2 || Math.abs(a.y - b.y) >= (a.height + b.height) / 2;
      assert.ok(separated, `${a.key} overlaps ${b.key}`);
    }
  }
}

test("the heaviest chain from the query runs straight through the center", () => {
  const layout = layoutKmerTree(upstream, downstream, options);
  const main = layout.nodes.filter((node) => node.main);
  assert.deepEqual(main.map((node) => node.coverage).sort((a, b) => a - b), [130, 132, 132, 137, 137]);
  for (const node of main) assert.equal(node.y, layout.centerY);
  assert.deepEqual(layout.nodes.filter((node) => node.side === "downstream" && !node.main && node.step === 1).map((node) => node.coverage).sort((a, b) => a - b), [2, 6]);
});

test("original tree paths survive reordering so expansions still find their node", () => {
  const layout = layoutKmerTree(upstream, downstream, options);
  const nodes = byKey(layout);
  assert.equal(nodes.get("downstream:1").coverage, 132);
  assert.equal(nodes.get("downstream:0").coverage, 6);
  assert.equal(nodes.get("downstream:1.0.0").parentKey, "downstream:1.0");
});

test("every step keeps one column regardless of node size", () => {
  const layout = layoutKmerTree(upstream, downstream, options);
  for (const side of ["upstream", "downstream"]) {
    const columns = new Map();
    for (const node of layout.nodes.filter((entry) => entry.side === side)) {
      columns.set(node.step, (columns.get(node.step) ?? new Set()).add(node.x));
    }
    for (const xs of columns.values()) assert.equal(xs.size, 1);
    const ordered = [...columns.entries()].sort(([a], [b]) => a - b).map(([, xs]) => [...xs][0]);
    const direction = side === "downstream" ? 1 : -1;
    for (let i = 0; i < ordered.length; i += 1) {
      const previous = i === 0 ? layout.centerX : ordered[i - 1];
      assert.ok((ordered[i] - previous) * direction > 0);
    }
  }
});

test("nodes and expanders never overlap and stay inside the canvas", () => {
  const layout = layoutKmerTree(upstream, downstream, options);
  const boxes = [
    ...layout.nodes,
    ...layout.expanders.map((entry) => ({ ...entry, key: `expand ${entry.key}`, width: 26, height: 26 })),
    { key: "center", x: layout.centerX, y: layout.centerY, width: 200, height: 56 }
  ];
  assertNoOverlap(boxes);
  for (const box of boxes) {
    assert.ok(box.x - box.width / 2 >= 0 && box.x + box.width / 2 <= layout.width, box.key);
    assert.ok(box.y - box.height / 2 >= 0 && box.y + box.height / 2 <= layout.height, box.key);
  }
});

test("sibling subtrees never cross between columns", () => {
  const wide = (depth) => (depth === 0 ? [] : ["A", "C", "G", "T"].map((base, index) => branch(base, 40 - index * 10, wide(depth - 1))));
  const layout = layoutKmerTree([], wide(4), options);
  assertNoOverlap(layout.nodes);
  const links = layout.nodes;
  for (let i = 0; i < links.length; i += 1) {
    for (let j = i + 1; j < links.length; j += 1) {
      const [a, b] = [links[i], links[j]];
      if (a.step !== b.step || a.fromY === b.fromY) continue;
      assert.equal(Math.sign(a.fromY - b.fromY), Math.sign(a.toY - b.toY), `${a.key} crosses ${b.key}`);
    }
  }
});

test("links start at the parent's edge and end at the child's edge", () => {
  const layout = layoutKmerTree(upstream, downstream, options);
  const nodes = byKey(layout);
  const first = nodes.get("downstream:1");
  assert.equal(first.fromX, layout.centerX + 100);
  assert.equal(first.fromY, layout.centerY);
  assert.equal(first.toX, first.x - 30);
  const second = nodes.get("downstream:1.1");
  assert.equal(second.fromX, first.x + 30);
  assert.equal(second.toX, second.x - second.width / 2);
  const left = nodes.get("upstream:0");
  assert.equal(left.fromX, layout.centerX - 100);
  assert.equal(left.toX, left.x + 30);
});

test("only open leaves get an expander, in the next column", () => {
  const tree = [branch("G", 50, [branch("A", 50), branch("T", 2, [], { exhausted: true })])];
  const layout = layoutKmerTree([], tree, options);
  assert.deepEqual(layout.expanders.map((entry) => entry.path), ["0.0"]);
  const nodes = byKey(layout);
  const leaf = nodes.get("downstream:0.0");
  assert.equal(layout.expanders[0].y, leaf.y);
  assert.ok(layout.expanders[0].x > leaf.x + leaf.width / 2);
  assert.equal(nodes.get("downstream:0.1").expandable, false);
  assert.equal(nodes.get("downstream:0.1").exhausted, true);
});

test("a side without branches leaves a note instead of columns", () => {
  const layout = layoutKmerTree(undefined, downstream, options);
  assert.deepEqual(layout.empty.map((note) => note.side), ["upstream"]);
  assert.ok(layout.empty[0].x < layout.centerX - 100);
  assert.equal(layout.empty[0].y, layout.centerY);
  assert.equal(layout.columns.filter((column) => column.side === "upstream").length, 0);
  const bare = layoutKmerTree([], [], options);
  assert.equal(bare.nodes.length, 0);
  assert.equal(bare.empty.length, 2);
});

test("fork shares use sibling coverage and stay null on unbranched steps", () => {
  const layout = layoutKmerTree(upstream, downstream, options);
  const nodes = byKey(layout);
  assert.equal(nodes.get("downstream:1").share, 132 / 140);
  assert.equal(nodes.get("downstream:2").share, 2 / 140);
  assert.equal(nodes.get("upstream:0").share, null);
  assert.equal(nodes.get("downstream:1.0.0").share, 130 / 132);
});

test("path keys walk out from the query", () => {
  assert.deepEqual(pathKeys("downstream:1.0.2"), ["downstream:1", "downstream:1.0", "downstream:1.0.2"]);
  assert.deepEqual(pathKeys("upstream:0"), ["upstream:0"]);
});

test("paths spell upstream bases before the query in reading order", () => {
  const layout = layoutKmerTree(upstream, downstream, options);
  const main = summarizeTreePath(layout, "CCC", null);
  assert.equal(main.sequence, "ATCCCGAG");
  assert.equal(main.prefix, "AT");
  assert.equal(main.suffix, "GAG");
  assert.equal(main.minCoverage, 130);
  assert.equal(main.forks, 3);
  assert.equal(main.end, null);

  const branchPath = summarizeTreePath(layout, "CCC", "downstream:0.1.0");
  assert.equal(branchPath.sequence, "CCCAGA");
  assert.equal(branchPath.minCoverage, 1);
  assert.equal(branchPath.end.key, "downstream:0.1.0");

  const leftPath = summarizeTreePath(layout, "CCC", "upstream:0.0");
  assert.equal(leftPath.sequence, "ATCCC");
  assert.equal(leftPath.downstreamSteps, 0);

  const bare = summarizeTreePath(layoutKmerTree([], [], options), "CCC", null);
  assert.equal(bare.sequence, "CCC");
  assert.equal(bare.minCoverage, null);
});

test("coverage scale is monotonic, clamped and safe without coverage", () => {
  assert.equal(scaleByCoverage(100, 100, 2, 12), 12);
  assert.equal(scaleByCoverage(0, 100, 2, 12), 2);
  assert.equal(scaleByCoverage(5, 0, 2, 12), 2);
  assert.equal(scaleByCoverage(500, 100, 2, 12), 12);
  assert.equal(scaleByCoverage(25, 100, 2, 12), 7);
  assert.ok(scaleByCoverage(6, 140, 2, 12) > scaleByCoverage(2, 140, 2, 12));
});

test("share labels never round a real minority away or claim a false 100%", () => {
  assert.equal(formatShare(132 / 140), "94%");
  assert.equal(formatShare(1), "100%");
  assert.equal(formatShare(0.003), "<1%");
  assert.equal(formatShare(0.998), ">99%");
});

test("compact coverage stays short at every magnitude", () => {
  assert.equal(formatCompactCoverage(0), "0");
  assert.equal(formatCompactCoverage(999), "999");
  assert.equal(formatCompactCoverage(1000), "1k");
  assert.equal(formatCompactCoverage(1234), "1.2k");
  assert.equal(formatCompactCoverage(9960), "10k");
  assert.equal(formatCompactCoverage(123456), "123k");
  assert.equal(formatCompactCoverage(999499), "999k");
  assert.equal(formatCompactCoverage(999500), "1M");
  assert.equal(formatCompactCoverage(12_345_678), "12M");
});
