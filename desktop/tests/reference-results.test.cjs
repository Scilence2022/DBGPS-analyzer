const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseReferenceResult, parseCombinedReport, filterOutput } = require("../dist/reference-results.js");

const reference = {
  type: "reference", k: 4, primerLen: 2, linksThreshold: 1, filterMaxLinks: 0,
  crossLinks: 1, totalStrands: 4, passedCount: 1, filteredCount: 2, skippedCount: 1,
  filteredNames: ["first", "second"], passedFasta: ">passed\nAAAACCCC\n"
};

test("one filter result supports both UI modes and saves the same passed FASTA", () => {
  const result = parseReferenceResult(JSON.stringify(reference));
  for (const listFiltered of [false, true]) {
    const output = filterOutput(result, listFiltered);
    assert.equal(output.stdout, listFiltered ? "first\nsecond\n" : reference.passedFasta);
    assert.equal(output.saveOutput, reference.passedFasta);
    assert.equal(output.passedCount, 1);
    assert.equal(output.filteredCount, 2);
    assert.equal(output.skippedCount, 1);
  }
});

test("reference result rejects inconsistent counts instead of misreporting skips as passed", () => {
  for (const changes of [{ passedCount: 2 }, { filteredNames: [] }, { skippedCount: -1 }, { totalStrands: null }]) {
    assert.throws(() => parseReferenceResult(JSON.stringify({ ...reference, ...changes })), /Invalid reference/);
  }
  assert.throws(() => filterOutput({ ...reference, passedFasta: undefined }, true), /Missing passed FASTA/);
});

test("combined report retains explicit counts and restores unavailable metrics to NaN", () => {
  const result = parseCombinedReport(JSON.stringify({
    type: "report", referenceFile: "reference.fa", ngsFiles: ["reads.fa"], reference,
    analyzer: { primerLen: 2, rows: [{ ratio: 0, coverage: 0, total: 4, paths: 0, noise: 3, exist: 0, lost: 0, sm: 0, kd: null, kn: null }] }
  }));
  assert.equal(result.reference.passedCount, 1);
  assert.equal(result.reference.skippedCount, 1);
  assert.equal(result.analyzer.primerLen, reference.primerLen);
  assert.equal(result.analyzer.rows[0].sm, 0);
  assert.ok(Number.isNaN(result.analyzer.rows[0].kd));
  assert.ok(Number.isNaN(result.analyzer.rows[0].kn));
  assert.equal(parseCombinedReport(JSON.stringify({ type: "report", reference, analyzer: null })).analyzer, null);
});
