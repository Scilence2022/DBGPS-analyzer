const { test } = require("node:test");
const assert = require("node:assert/strict");
const { adjacentFoldChanges, foldAxisCap, formatFold, formatLog2, describeFoldEdge } = require("../dist/fold-change.js");

test("fold change is signed: drops are negative, rises positive", () => {
  const edges = adjacentFoldChanges([40, 20, 20, 80]);
  assert.deepEqual(edges.map((e) => e.log2), [-1, 0, 2]);
  assert.ok(edges.every((e) => e.kind === "change"));
});

test("edges touching zero coverage are flagged, not given a finite value", () => {
  const edges = adjacentFoldChanges([30, 0, 0, 12]);
  assert.deepEqual(edges.map((e) => [e.kind, e.log2]), [["to-zero", null], ["both-zero", null], ["from-zero", null]]);
  assert.equal(adjacentFoldChanges([5]).length, 0);
});

test("axis cap is symmetric whole log2 units, at least 1 and bounded", () => {
  assert.equal(foldAxisCap(adjacentFoldChanges([10, 11, 10])), 1);
  assert.equal(foldAxisCap(adjacentFoldChanges([40, 10, 30])), 2);
  assert.equal(foldAxisCap(adjacentFoldChanges([1, 4096])), 6);
  assert.equal(foldAxisCap(adjacentFoldChanges([9, 0, 9])), 1, "zero edges do not stretch the axis");
});

test("labels read as both log2 and linear fold", () => {
  assert.equal(formatLog2(-1), "−1.00");
  assert.equal(formatLog2(0.001), "0.00");
  assert.equal(formatFold(-1), "0.50×");
  assert.equal(formatFold(1), "2.0×");
  assert.equal(formatFold(4), "16×");
  assert.equal(describeFoldEdge(adjacentFoldChanges([40, 20])[0]), "windows 0→1: 40 → 20 (log₂ −1.00, 0.50×)");
  assert.equal(describeFoldEdge(adjacentFoldChanges([7, 0])[0]), "windows 0→1: 7 → 0 (drops to zero coverage)");
});
