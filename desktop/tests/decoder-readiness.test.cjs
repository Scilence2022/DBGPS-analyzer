const { test } = require("node:test");
const assert = require("node:assert/strict");
const { failureLabel, failureRows, hotspotKmers, hotspotShare, parseWaivedKmers, shouldOfferWaiver } = require("../dist/decoder-readiness.js");

test("failure rows drop empty reasons and put the largest first", () => {
  const rows = failureRows({ missing: 3, ratio_rise: 9, below_cutoff: 0 }, 100);
  assert.deepEqual(rows.map((row) => row.failure), ["ratio_rise", "missing"]);
  assert.equal(rows[0].share, 0.09);
  assert.equal(rows[0].label, "Coverage rose past the ratio window");
  assert.deepEqual(failureRows({ missing: 1 }, 0).map((row) => row.share), [0]);
});

test("unknown failures keep their name instead of disappearing", () => {
  assert.equal(failureLabel("future_reason"), "future_reason");
  assert.equal(failureLabel("ok"), "Decodable");
});

test("waived k-mers parse strictly", () => {
  assert.deepEqual(parseWaivedKmers("50, 120"), [50, 120]);
  assert.deepEqual(parseWaivedKmers(" 50 120 "), [50, 120]);
  assert.deepEqual(parseWaivedKmers(""), []);
  assert.throws(() => parseWaivedKmers("50, x"), /not a k-mer index/);
  assert.throws(() => parseWaivedKmers("-1"), /not a k-mer index/);
  assert.throws(() => parseWaivedKmers(Array(17).fill("1").join(",")), /at most 16/);
});

test("hotspots sort by position and report their share of ratio failures", () => {
  const spots = [{ kmer: 120, count: 25 }, { kmer: 50, count: 25 }];
  assert.deepEqual(hotspotKmers(spots), [50, 120]);
  assert.equal(hotspotShare(spots, 100), 0.5);
  assert.equal(hotspotShare(spots, 0), 0);
});

test("a waiver is offered only for a step that explains the losses", () => {
  const spots = [{ kmer: 50, count: 2854 }, { kmer: 120, count: 2483 }];
  assert.equal(shouldOfferWaiver(spots, 5544, 6857), true);
  assert.equal(shouldOfferWaiver([{ kmer: 4, count: 57 }], 175, 169424), false, "a third of residual failures is not a step");
  assert.equal(shouldOfferWaiver([{ kmer: 4, count: 90 }], 175, 169424), false, "ratio failures too rare to matter");
  assert.equal(shouldOfferWaiver([], 0, 100), false);
});
