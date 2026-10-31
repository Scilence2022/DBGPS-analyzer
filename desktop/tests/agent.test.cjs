const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runReadOnlyAgent, executeAgentTool, compactAgentContext, boundedAgentMessages, agentToolAvailability, AGENT_TOOLS, AGENT_LIMITS } = require("../dist/agent.js");
const { AgentEvidenceStore } = require("../dist/agent-evidence.js");
const { AnalyzerQueryQueue, validateReadOnlyCommand } = require("../dist/analyzer-queue.js");

const settings = { apiStyle: "openai-compatible", baseUrl: "http://127.0.0.1", model: "fixture", apiKey: "", temperature: 0, maxTokens: 128 };
const snapshot = { id: "snapshot-fixture", datasetVersion: "index-1", batchVersion: "batch-1", createdAt: "2026-10-06T00:00:00Z", context: {} };
const messages = [{ role: "user", content: "Which windows are unsupported?" }];
function backend(overrides = {}) {
  return {
    assertCurrent() {}, getK: () => 3,
    getSummary: async () => ({ distinctKmers: 8 }),
    getSequence: async () => ({ reference: { index: 7 }, result: { type: "sequence", k: 3, observed: 2, missing: 1, coverages: [{ position: 0, coverage: 4 }, { position: 1, coverage: 3 }, { position: 2, coverage: 0 }], ratios: [] } }),
    queryKmer: async (kmer, depth) => ({ type: "kmer", query: kmer, depth }),
    getBatchRows: () => ({ rows: [] }), findBatchRecords: (names) => ({ rows: [], unmatched: names }), ...overrides
  };
}
function run(provider, overrides = {}) {
  return runReadOnlyAgent({ snapshot, settings, messages, provider, backend: backend(), signal: new AbortController().signal, ...overrides });
}
const call = (name, args = {}, id = "call-1") => ({ text: "", calls: [{ id, name, arguments: args }], continuation: {} });

test("model-selected tool, deterministic evidence, then final response", async () => {
  let turns = 0;
  const events = [];
  const result = await run(async (request) => {
    if (++turns === 1) return call("get_sequence_profile", { recordIndex: 7, offset: 1, limit: 2 });
    const evidence = JSON.parse(request.previous[0].outputs[0].output);
    assert.equal(evidence.ok, true);
    assert.equal(evidence.snapshotId, snapshot.id);
    assert.deepEqual(evidence.data.coverageSlice.positions, [{ position: 1, coverage: 3 }, { position: 2, coverage: 0 }]);
    assert.equal(evidence.data.coverageSlice.truncated, true);
    return { text: "Position 2 lacks support; cause is not established.", calls: [], continuation: {} };
  }, { onTrace: (trace) => events.push(trace.status) });
  assert.equal(result.stopReason, "completed");
  assert.equal(result.modelTurns, 2);
  assert.deepEqual(events, ["running", "ok"]);
  assert.equal(result.trace[0].status, "ok");
});

test("unknown state-changing tool is rejected and returned as failed evidence", async () => {
  let executed = false;
  let turns = 0;
  const result = await run(async (request) => {
    if (++turns === 1) return call("run_shell", { command: "rm anything" });
    const evidence = JSON.parse(request.previous[0].outputs[0].output);
    assert.equal(evidence.ok, false);
    assert.match(evidence.error, /allowlist/);
    return { text: "That operation is unavailable.", calls: [], continuation: {} };
  }, { backend: backend({ getSummary: async () => { executed = true; } }) });
  assert.equal(executed, false);
  assert.equal(result.trace[0].status, "error");
});

for (const [name, args] of [
  ["get_analysis_summary", { file: "/tmp/arbitrary" }],
  ["query_kmer", { kmer: "AAA\nexit", depth: 1 }],
  ["query_kmer", { kmer: "AAAA", depth: 1 }],
  ["query_kmer", { kmer: "AAA", depth: 3 }],
  ["query_kmer", { kmer: "AAA", depth: "1" }],
  ["get_sequence_profile", { recordIndex: -1, offset: 0, limit: 128 }],
  ["get_sequence_profile", { recordIndex: 1.5, offset: 0, limit: 128 }],
  ["get_sequence_profile", { recordIndex: null, offset: 0, limit: 129 }],
  ["get_batch_rows", { status: "complete", offset: 0, limit: 25 }],
  ["get_batch_rows", { status: "all", offset: -1, limit: 25 }],
  ["find_batch_records", { names: [] }],
  ["find_batch_records", { names: "strand" }],
  ["find_batch_records", { names: [""] }],
  ["find_batch_records", { names: Array.from({ length: 26 }, (_, i) => `s${i}`) }],
  ["find_batch_records", { names: ["x".repeat(201)] }]
]) test(`runtime rejects ${name} arguments ${JSON.stringify(args)}`, async () => {
  await assert.rejects(executeAgentTool(name, args, backend(), new AbortController().signal));
});

test("tool result exceeding its budget is not adopted", async () => {
  await assert.rejects(executeAgentTool("get_analysis_summary", {}, backend({ getSummary: async () => ({ text: "x".repeat(AGENT_LIMITS.toolResultChars) }) }), new AbortController().signal), /budget/);
});

test("tool budget rejects an oversized batch before executing any action", async () => {
  let executions = 0;
  const result = await run(async () => ({ text: "", calls: Array.from({ length: 7 }, (_, i) => ({ id: `call-${i}`, name: "get_analysis_summary", arguments: {} })), continuation: {} }), { backend: backend({ getSummary: async () => { executions++; return {}; } }) });
  assert.equal(result.stopReason, "budget");
  assert.equal(executions, 0);
});

test("last model turn disables tools and permits an evidence-based answer", async () => {
  let turns = 0;
  const result = await run(async (request) => {
    turns++;
    if (turns < AGENT_LIMITS.modelTurns) return call("get_analysis_summary", {}, `call-${turns}`);
    assert.equal(request.tools.length, 0);
    return { text: "Answer from retained observations.", calls: [], continuation: {} };
  });
  assert.equal(result.stopReason, "completed");
  assert.equal(result.modelTurns, 5);
});

test("an empty reply is retried once without tools and the answer completes the run", async () => {
  let turns = 0;
  const seen = [];
  const result = await run(async (request) => {
    seen.push(request);
    turns++;
    if (turns === 1) return call("get_analysis_summary");
    if (turns === 2) return { text: "  ", calls: [], continuation: {} };
    return { text: "Answer from retained evidence.", calls: [], continuation: {} };
  });
  assert.equal(result.stopReason, "completed");
  assert.equal(result.content, "Answer from retained evidence.");
  assert.equal(seen[1].tools.length, AGENT_TOOLS.length);
  assert.equal(seen[2].tools.length, 0);
  assert.equal(seen[2].previous.length, 0);
  assert.equal(seen[2].disableThinking, true);
  assert.equal(seen[1].disableThinking, undefined);
  assert.equal(seen[2].messages.length, messages.length);
  assert.match(seen[2].messages.at(-1).content, /Which windows are unsupported\?[\s\S]*distinctKmers[\s\S]*No tools remain/);
});

test("an empty reply on the last turn still gets its retry", async () => {
  let turns = 0;
  const result = await run(async () => {
    turns++;
    if (turns < AGENT_LIMITS.modelTurns) return call("get_analysis_summary", {}, `call-${turns}`);
    return turns === AGENT_LIMITS.modelTurns ? { text: "", calls: [], continuation: {} } : { text: "Recovered.", calls: [], continuation: {} };
  });
  assert.equal(result.stopReason, "completed");
  assert.equal(result.modelTurns, AGENT_LIMITS.modelTurns + 1);
});

test("the answer-only retry declares evidence over the history budget", async () => {
  let turns = 0;
  let retry;
  await run(async (request) => {
    if (++turns === 1) return call("get_analysis_summary");
    if (turns === 2) return { text: "", calls: [], continuation: {} };
    retry = request;
    return { text: "Done.", calls: [], continuation: {} };
  }, { backend: backend({ getSummary: async () => ({ text: "x".repeat(AGENT_LIMITS.toolResultChars - 20) }) }) });
  assert.doesNotMatch(retry.messages.at(-1).content, /omitted/);
  turns = 0;
  await run(async (request) => {
    turns++;
    if (turns <= 3) return { text: "", calls: Array.from({ length: 2 }, (_, i) => ({ id: `call-${turns}-${i}`, name: "get_analysis_summary", arguments: {} })), continuation: {} };
    if (turns === 4) return { text: "", calls: [], continuation: {} };
    retry = request;
    return { text: "Done.", calls: [], continuation: {} };
  }, { backend: backend({ getSummary: async () => ({ text: "x".repeat(AGENT_LIMITS.toolResultChars - 20) }) }) });
  assert.match(retry.messages.at(-1).content, /5 omitted by the evidence budget/);
  assert.ok(retry.messages.at(-1).content.length <= AGENT_LIMITS.historyChars + 1000);
});

test("a second empty reply stops with the retrieved evidence and one sentence ending", async () => {
  let turns = 0;
  const result = await run(async () => (++turns === 1 ? call("get_sequence_profile", { recordIndex: 7, offset: 0, limit: 3 }) : { text: "", calls: [], continuation: {} }));
  assert.equal(result.stopReason, "error");
  assert.equal(turns, 3);
  assert.match(result.content, /fixture returned no final answer/);
  assert.match(result.content, /select a larger model\. No final interpretation/);
  assert.match(result.content, /Read coverage profile \(record 7 \(row #8\) · windows 0–2\): 3 of 3 windows; min 0 · max 4/);
});

test("provider errors ending in a period do not repeat it", async () => {
  const result = await run(async () => { throw new Error("Provider request failed (HTTP 500)."); });
  assert.equal(result.content, "Agent stopped: Provider request failed (HTTP 500). No final interpretation was completed.");
});

test("a slow model is moved to its final turn while the deadline can still be met", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  let turns = 0;
  const offered = [];
  const result = await run(async (request) => {
    offered.push(request.tools.length);
    turns++;
    t.mock.timers.tick(AGENT_LIMITS.answerAfterMs);
    return turns === 1 ? call("get_analysis_summary") : { text: "Answer in time.", calls: [], continuation: {} };
  });
  assert.equal(result.stopReason, "completed");
  assert.deepEqual(offered, [AGENT_TOOLS.length, 0]);
});

test("a rejected k-mer tells the model the loaded k", async () => {
  await assert.rejects(executeAgentTool("query_kmer", { kmer: "101010111", depth: 1 }, backend({ getK: () => 18 }), new AbortController().signal), /exactly 18 bases/);
});

test("repeated call IDs do not execute a second action", async () => {
  const result = await run(async () => call("get_analysis_summary"));
  assert.equal(result.stopReason, "error");
  assert.equal(result.trace.length, 1);
});

test("cancellation between model output and dispatch executes no tool", async () => {
  const controller = new AbortController();
  const result = await run(async () => { controller.abort("canceled"); return call("get_analysis_summary"); }, { signal: controller.signal });
  assert.equal(result.stopReason, "canceled");
  assert.equal(result.trace.length, 0);
});

test("changed dataset after a query invalidates the observation", async () => {
  let changed = false;
  const result = await run(async () => call("get_analysis_summary"), { backend: backend({ assertCurrent() { if (changed) throw new Error("stale snapshot"); }, getSummary: async () => { changed = true; return { count: 99 }; } }) });
  assert.equal(result.stopReason, "error");
  assert.equal(result.trace[0].status, "error");
  assert.equal(result.trace[0].result.ok, false);
});

test("deadline and dataset-change abort reasons are preserved", async () => {
  for (const reason of ["deadline", "dataset_changed"]) {
    const controller = new AbortController(); controller.abort(reason);
    const result = await run(async () => { throw new Error("must not call provider"); }, { signal: controller.signal });
    assert.equal(result.stopReason, reason);
  }
});

test("compaction keeps valid structured evidence and declares omitted paths/arrays", () => {
  const context = compactAgentContext({ command: "secret path", data: Array.from({ length: 40 }, (_, i) => i), text: "x".repeat(2000) });
  assert.equal(context.data.command, undefined);
  assert.equal(context.data.data.length, 25);
  assert(context.omissionCount >= 3);
  assert(JSON.stringify(context).length < AGENT_LIMITS.contextChars);
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(context))), JSON.stringify(context));
});

test("history budget declares omitted messages rather than slicing the latest question", () => {
  const result = boundedAgentMessages([{ role: "user", content: "x".repeat(48000) }, { role: "assistant", content: "old answer" }, { role: "user", content: "new question" }]);
  assert.equal(result.length, 1);
  assert.match(result[0].content, /earlier messages omitted/);
  assert.match(result[0].content, /new question/);
});

test("generation record uses effective token cap and cannot expose endpoint credentials", async () => {
  const result = await run(async (request) => {
    assert.equal(request.settings.maxTokens, AGENT_LIMITS.outputTokens);
    return { text: "Conceptual answer.", calls: [], continuation: {} };
  }, { settings: { ...settings, maxTokens: 100000, apiKey: "credential-secret", baseUrl: "http://user:password@127.0.0.1/v1?token=secret" } });
  assert.equal(result.generation.endpointOrigin, "http://127.0.0.1");
  assert(!JSON.stringify(result).includes("credential-secret"));
  assert(!JSON.stringify(result).includes("password"));
});

test("prototype keys cannot modify the compact evidence envelope", () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"value":1}');
  const result = compactAgentContext(input);
  assert.equal({}.polluted, undefined);
  assert.equal(result.data.value, 1);
  assert.equal(Object.getPrototypeOf(result.data), null);
});

test("active-view observation from an older index is omitted rather than rebound", () => {
  const store = new AgentEvidenceStore();
  store.activate({ k: 3, threads: 1, readLength: 200 });
  const { snapshot: fresh } = store.open({ activeView: { datasetVersion: "old-index", observed: 123 } }, null);
  assert.equal(fresh.context.data.activeView.unavailable, true);
  assert.equal(fresh.context.data.activeView.observed, undefined);
});

test("main-owned batch snapshot uses indices, filters anomalies beyond row 25, and retains trim scope", async () => {
  const store = new AgentEvidenceStore();
  const version = store.activate({ k: 3, threads: 2, readLength: 200 });
  const rows = Array.from({ length: 30 }, (_, index) => ({ index, name: `record-${index}`, rawLength: 10, analyzedLength: 6, status: "ok", summary: { type: "sequenceSummary", length: 6, k: 3, kmerCount: 4, observed: index === 29 ? 3 : 4, missing: index === 29 ? 1 : 0, complete: index !== 29, minCoverage: 0, maxCoverage: 3, meanCoverage: 2, maxAdjacentRatio: 1 } }));
  store.cacheBatch(version, 2, 2, rows, new Map([[29, "AAACCC"]]));
  rows[29].name = "mutated externally";
  const commands = [];
  const { backend: cached, snapshot: fixed } = store.open({}, { query: async (command) => { commands.push(command); return { type: "sequence", coverages: [], ratios: [] }; } });
  const selection = cached.getBatchRows("incomplete", 0, 25);
  assert.equal(selection.aggregates.complete, 29);
  assert.equal(selection.rows[0].index, 29);
  assert.equal(selection.rows[0].name, "record-29");
  assert.equal(selection.primerFront, 2);
  await cached.getSequence(29, new AbortController().signal);
  assert.deepEqual(commands, ["sequence AAACCC"]);
  assert.equal(fixed.datasetVersion, version);
  store.invalidate();
  assert.throws(() => cached.assertCurrent(), /stale/);
});

test("strand names resolve to their cached records and report unmatched names", async () => {
  const store = new AgentEvidenceStore();
  const version = store.activate({ k: 3, threads: 1, readLength: 200 });
  const row = (index, name) => ({ index, name, rawLength: 6, analyzedLength: 6, status: "ok", summary: { type: "sequenceSummary", length: 6, k: 3, kmerCount: 4, observed: 4, missing: 0, complete: true, minCoverage: 1, maxCoverage: 3, meanCoverage: 2, maxAdjacentRatio: 1 } });
  store.cacheBatch(version, 0, 0, [row(0, "seq_37"), row(1, "seq_0"), row(2, "seq_5")], new Map([[1, "AAACCC"]]));
  const { backend: cached } = store.open({}, { query: async () => ({ type: "sequence", coverages: [], ratios: [] }) });
  const result = await executeAgentTool("find_batch_records", { names: ["seq_0", "seq_37", "seq_99"] }, cached, new AbortController().signal);
  assert.deepEqual(result.rows.map((item) => [item.index, item.name, item.profileCached]), [[0, "seq_37", false], [1, "seq_0", true]]);
  assert.deepEqual(result.unmatched, ["seq_99"]);
  assert.equal(result.selection.matchedRows, 2);
});

test("cached profile cannot open a model-supplied path or use an unknown row", async () => {
  const store = new AgentEvidenceStore(); store.activate({ k: 3, threads: 1, readLength: 200 });
  const { backend: cached } = store.open({}, { query: async () => { throw new Error("must not query"); } });
  await assert.rejects(cached.getSequence(100, new AbortController().signal), /unavailable/);
});

test("changing selected Interactive sequence does not alter an existing snapshot", async () => {
  const store = new AgentEvidenceStore(); store.activate({ k: 3, threads: 1, readLength: 200 });
  store.selectSequence("AAACCC");
  const commands = [];
  const { backend: fixed } = store.open({}, { query: async (command) => { commands.push(command); return { type: "sequence", coverages: [], ratios: [] }; } });
  store.selectSequence("CCCGGG");
  await fixed.getSequence(null, new AbortController().signal);
  assert.deepEqual(commands, ["sequence AAACCC"]);
});

test("canceling a written FIFO query preserves its slot until drained", async () => {
  const queue = new AnalyzerQueryQueue(() => { throw new Error("unexpected timeout"); });
  const controller = new AbortController();
  const first = queue.enqueue(() => {}, 1000, controller.signal);
  const canceled = assert.rejects(first);
  const second = queue.enqueue(() => {}, 1000);
  controller.abort("canceled");
  queue.complete({ query: "first" });
  queue.complete({ query: "second" });
  await canceled;
  assert.deepEqual(await second, { query: "second" });
});

test("FIFO timeout fails all waiters and closes the session instead of shifting attribution", async () => {
  let terminated = 0;
  const queue = new AnalyzerQueryQueue(() => terminated++);
  const first = queue.enqueue(() => {}, 10);
  const second = queue.enqueue(() => {}, 1000);
  await Promise.all([assert.rejects(first, /timed out/), assert.rejects(second, /timed out/)]);
  assert.equal(terminated, 1);
  assert.equal(queue.complete({ stale: true }), false);
});

test("write failure settles all pending FIFO work", async () => {
  let terminated = 0;
  const queue = new AnalyzerQueryQueue(() => terminated++);
  const first = queue.enqueue(() => {}, 1000);
  const second = queue.enqueue((callback) => callback(new Error("write failed")), 1000);
  await Promise.all([assert.rejects(first, /write failed/), assert.rejects(second, /write failed/)]);
  assert.equal(terminated, 1);
});

test("generic desktop queries cannot inject commands or mutate the read index", () => {
  for (const command of ["summary\nexit", "summary\raddFile secret", "addFile anything", "exit", "batch /etc/passwd", "summary\0"]) assert.throws(() => validateReadOnlyCommand(command));
  for (const command of ["summary", "sequence ACGT", "kmer ACG 1 1", "index 42 31 1 1"]) assert.doesNotThrow(() => validateReadOnlyCommand(command));
});

test("progress reports each model turn with the tool count before the request", async () => {
  const progress = [];
  let turns = 0;
  const result = await run(async () => (++turns === 1 ? call("get_analysis_summary") : { text: "done", calls: [], continuation: {} }), {
    onProgress: (event) => progress.push(event)
  });
  assert.equal(result.stopReason, "completed");
  assert.deepEqual(progress, [
    { phase: "model", modelTurns: 1, toolCalls: 0, finalTurn: false },
    { phase: "model", modelTurns: 2, toolCalls: 1, finalTurn: false }
  ]);
});

test("evidence status exposes counts only and drives per-tool availability", () => {
  const store = new AgentEvidenceStore();
  const empty = store.status();
  assert.equal(empty.datasetVersion, null);
  assert.ok(agentToolAvailability(empty).every((tool) => !tool.available && /Start the kernel/.test(tool.reason)));
  assert.deepEqual(agentToolAvailability(empty).map((tool) => tool.name), AGENT_TOOLS.map((tool) => tool.name));

  const version = store.activate({ k: 3, threads: 1, readLength: 200 });
  let byName = Object.fromEntries(agentToolAvailability(store.status()).map((tool) => [tool.name, tool]));
  assert.equal(byName.get_analysis_summary.available, true);
  assert.equal(byName.query_kmer.available, true);
  assert.equal(byName.get_batch_rows.available, false);
  assert.equal(byName.find_batch_records.available, false);
  assert.equal(byName.get_sequence_profile.available, false);

  const rows = [{ index: 0, name: "secret-name", rawLength: 6, analyzedLength: 6, status: "ok", summary: { type: "sequenceSummary", length: 6, k: 3, kmerCount: 4, observed: 3, missing: 1, complete: false, minCoverage: 0, maxCoverage: 3, meanCoverage: 2, maxAdjacentRatio: 1 } }];
  store.cacheBatch(version, 1, 2, rows, new Map([[0, "AAACCC"]]));
  const status = store.status();
  assert.deepEqual(status.batch, { total: 1, complete: 0, incomplete: 1, skipped: 0, errors: 0, cachedProfiles: 1, primerFront: 1, primerBack: 2 });
  assert.equal(JSON.stringify(status).includes("secret-name"), false);
  assert.equal(JSON.stringify(status).includes("AAACCC"), false);
  byName = Object.fromEntries(agentToolAvailability(status).map((tool) => [tool.name, tool]));
  assert.equal(byName.get_batch_rows.available, true);
  assert.equal(byName.find_batch_records.available, true);
  assert.equal(byName.get_sequence_profile.available, true);

  const reference = agentToolAvailability({ ...status, indexScope: "reference" }).find((tool) => tool.name === "query_kmer");
  assert.equal(reference.available, false);
  assert.match(reference.reason, /Bloom encoded sequence mode/);
});
