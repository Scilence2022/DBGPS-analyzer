const { test } = require("node:test");
const assert = require("node:assert/strict");
const { prepareBloomReference, analyzerScope, adoptSequenceSummary } = require("../dist/analyzer-config.js");
const { AgentEvidenceStore } = require("../dist/agent-evidence.js");
const { executeAgentTool, compactAgentContext, runReadOnlyAgent } = require("../dist/agent.js");

const config = { files: ["reads.fq"], k: 3, threads: 1, readLength: 200 };
const scope = {
  indexScope: "reference", referenceFile: "/references/library.tsv", targetKmers: 8,
  bloom: { backend: "bfc-blocked", bytes: 64, bitsPerKey: 16, hashes: 11 },
  globalNoiseAvailable: false, unrestrictedQueriesAvailable: false
};
const summary = {
  type: "sequenceSummary", length: 5, k: 3, kmerCount: 3, observed: 2, missing: 1,
  complete: false, minCoverage: 0, maxCoverage: 4, meanCoverage: 2, maxAdjacentRatio: 2
};
const signal = () => new AbortController().signal;
const noNormalization = () => { throw new Error("must not normalize"); };

test("default and explicitly disabled mode never normalize or emit Bloom flags", () => {
  for (const extra of [{}, { bloom: false, bloomReference: "unreadable.tsv", bloomBits: -1 }]) {
    const prepared = prepareBloomReference({ ...config, ...extra }, noNormalization);
    assert.deepEqual(prepared.args, []);
    assert.equal(prepared.referenceFile, undefined);
    prepared.cleanup();
  }
});

test("enabled mode normalizes the full reference once and defaults to 16 bits", () => {
  let cleaned = 0;
  const prepared = prepareBloomReference({ ...config, bloom: true, bloomReference: "library.tsv" }, (...args) => {
    assert.deepEqual(args, ["library.tsv"]);
    return { path: "/tmp/normalized-reference.fa", cleanup: () => cleaned++ };
  });
  assert.deepEqual(prepared.args, ["--bloom", "--bloom-reference", "/tmp/normalized-reference.fa", "--bloom-bits", "16"]);
  assert.equal(prepared.referenceFile, "library.tsv");
  assert.equal(cleaned, 0);
  prepared.cleanup();
  assert.equal(cleaned, 1);
});

test("Bloom bits accept only integer values within inclusive 4..64 bounds", () => {
  for (const bloomBits of [4, 16, 64]) {
    const prepared = prepareBloomReference({ ...config, bloom: true, bloomReference: "ref.fa", bloomBits }, (file) => ({ path: file, cleanup() {} }));
    assert.equal(prepared.args.at(-1), String(bloomBits));
  }
  for (const bloomBits of [3, 65, 4.5, NaN, Infinity, "16", null]) {
    assert.throws(() => prepareBloomReference({ ...config, bloom: true, bloomReference: "ref.fa", bloomBits }, noNormalization), /integer from 4 to 64/);
  }
});

test("enabled mode rejects a missing reference before normalization", () => {
  for (const bloomReference of [undefined, "", "   ", 16]) {
    assert.throws(() => prepareBloomReference({ ...config, bloom: true, bloomReference }, noNormalization), /Select a reference/);
  }
});

test("full-mode metadata remains absent, including in evidence snapshots and summaries", async () => {
  assert.deepEqual(analyzerScope({}), {});
  const store = new AgentEvidenceStore();
  store.activate(config);
  const { snapshot, backend } = store.open({}, { query: async () => ({ type: "summary", k: 3, distinctKmers: 12, totalKmerCoverage: 30 }) });
  const result = await backend.getSummary(signal());
  for (const key of Object.keys(scope)) {
    assert.equal(Object.hasOwn(snapshot, key), false);
    assert.equal(Object.hasOwn(result, key), false);
  }
});

test("activation retains an independent copy of reference scope in summary and captured snapshot", async () => {
  const input = { ...config, ...scope, bloom: { ...scope.bloom } };
  const store = new AgentEvidenceStore();
  store.activate(input);
  input.bloom.bitsPerKey = 64;
  const { snapshot, backend } = store.open({ activeView: { ...scope, type: "summary" } }, {
    query: async () => ({ type: "summary", k: 3, distinctKmers: 2, totalKmerCoverage: 6 })
  });
  assert.deepEqual(analyzerScope(snapshot), scope);
  const result = await executeAgentTool("get_analysis_summary", {}, backend, signal());
  assert.deepEqual(analyzerScope(result), scope);
  assert.equal(result.distinctKmers, 2);
  assert.equal(result.totalKmerCoverage, 6);
  assert.match(result.exactness, /observed reference keys/);
  assert.equal(snapshot.context.data.activeView.referenceFile, scope.referenceFile);
});

test("scope survives context compaction and a stale active view", () => {
  const compact = compactAgentContext(scope);
  assert.deepEqual(analyzerScope(compact.data), scope);
  const store = new AgentEvidenceStore();
  store.activate({ ...config, ...scope });
  const { snapshot } = store.open({ activeView: { datasetVersion: "old", observed: 999 }, huge: "x".repeat(20000) }, null);
  assert.deepEqual(analyzerScope(snapshot), scope);
  assert.equal(snapshot.context.data.activeView.observed, undefined);
  assert.equal(snapshot.context.data.activeView.unavailable, true);
});

test("reference sequence evidence and saved agent traces preserve index scope", async () => {
  const store = new AgentEvidenceStore();
  store.activate({ ...config, ...scope });
  store.selectSequence("AAACC");
  const { snapshot, backend } = store.open({}, { query: async (command) => {
    assert.equal(command, "sequence AAACC");
    return { ...summary, type: "sequence", coverages: [{ position: 0, coverage: 4 }], ratios: [] };
  } });
  let turns = 0;
  const result = await runReadOnlyAgent({
    snapshot, backend, signal: signal(), messages: [{ role: "user", content: "What is the support?" }],
    settings: { apiStyle: "openai-compatible", model: "fixture", baseUrl: "http://127.0.0.1", apiKey: "", temperature: 0, maxTokens: 128 },
    provider: async (request) => {
      assert.match(request.system, /off-target coverage cannot be measured/);
      if (++turns === 1) return { text: "", calls: [{ id: "profile", name: "get_sequence_profile", arguments: { recordIndex: null, offset: 0, limit: 1 } }], continuation: {} };
      const output = JSON.parse(request.previous[0].outputs[0].output);
      assert.deepEqual(analyzerScope(output.data.summary), scope);
      return { text: "Reference-only support; global noise is unavailable.", calls: [], continuation: {} };
    }
  });
  assert.equal(result.stopReason, "completed");
  assert.deepEqual(analyzerScope(result.snapshot), scope);
  assert.deepEqual(analyzerScope(result.trace[0].result.data.summary), scope);
});

test("reference graph queries fail before calling the kernel", async () => {
  const store = new AgentEvidenceStore();
  store.activate({ ...config, ...scope });
  const { backend } = store.open({}, { query: async () => { throw new Error("must not query"); } });
  await assert.rejects(executeAgentTool("query_kmer", { kmer: "AAA", depth: 0 }, backend, signal()), /unavailable in reference mode/);
});

test("nonindexed Batch QC records are errors, not zero-coverage or incomplete records", () => {
  const rejected = adoptSequenceSummary({ type: "error", message: "k-mer is outside the reference key set", kmerCount: 3 });
  assert.equal(rejected.status, "error");
  assert.equal(rejected.summary, undefined);
  assert.match(rejected.message, /outside the reference/);
  const accepted = adoptSequenceSummary(summary);
  assert.equal(accepted.status, "ok");
  const store = new AgentEvidenceStore();
  const version = store.activate({ ...config, ...scope });
  const row = { name: "target", rawLength: 5, analyzedLength: 5 };
  store.cacheBatch(version, 1, 1, [{ ...row, index: 0, ...accepted }, { ...row, index: 1, ...rejected }], new Map([[0, "AAACC"]]));
  const { backend } = store.open({}, null);
  const errors = backend.getBatchRows("error", 0, 25);
  assert.deepEqual(analyzerScope(errors), scope);
  assert.equal(errors.aggregates.errors, 1);
  assert.equal(errors.aggregates.incomplete, 1);
  assert.equal(errors.rows[0].index, 1);
  assert.equal(backend.getBatchRows("incomplete", 0, 25).selection.matchedTotal, 1);
});

test("out-of-reference sequence errors never become agent coverage measurements", async () => {
  const store = new AgentEvidenceStore();
  store.activate({ ...config, ...scope });
  store.selectSequence("AAACC");
  const { backend } = store.open({}, { query: async () => ({ type: "error", message: "outside reference" }) });
  await assert.rejects(executeAgentTool("get_sequence_profile", { recordIndex: null, offset: 0, limit: 1 }, backend, signal()), /no measurement adopted/);
});
