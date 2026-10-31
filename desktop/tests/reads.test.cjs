const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const vm = require("node:vm");
const ts = require("typescript");

// Run the real renderer with inert DOM elements and controlled IPC promises.
// No test hooks or alternative read-management implementation are bundled in the app.
const renderer = ts.transpileModule(readFileSync(require.resolve("../src/renderer.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
const rendererRequire = createRequire(require.resolve("../dist/main.js"));

function element() {
  const classes = new Set();
  return {
    listeners: {},
    dataset: {}, style: { setProperty() {} }, value: "", textContent: "", innerHTML: "", hidden: false,
    classList: {
      add(...values) { values.forEach((v) => classes.add(v)); },
      remove(...values) { values.forEach((v) => classes.delete(v)); },
      contains(value) { return classes.has(value); },
      toggle(value, on) { on ? classes.add(value) : classes.delete(value); }
    },
    addEventListener(type, callback) { this.listeners[type] = callback; },
    setAttribute() {}, appendChild() {}, remove() {}, focus() {},
    querySelector(selector) { return selector === "span" ? (this.span ??= element()) : null; },
    querySelectorAll() { return []; }
  };
}

async function app(overrides = {}) {
  const nodes = new Map();
  const get = (id) => nodes.get(id) ?? (nodes.set(id, element()), nodes.get(id));
  const calls = [];
  const api = {
    loadSecrets: async () => ({}), saveSecrets: async () => ({}),
    onAnalyzerEvent() {}, onAiChatChunk() {}, onAiTool() {}, onAiProgress() {},
    async startAnalyzer(config) {
      calls.push(JSON.parse(JSON.stringify(config)));
      return { ...config, type: "ready", distinctKmers: 10, totalKmerCoverage: config.files.length * 20 };
    },
    async stopAnalyzer() { calls.push("stop"); },
    ...overrides
  };
  const context = vm.createContext({
    exports: {}, console,
    require: (name) => name === "lucide" ? { createIcons() {}, icons: {} } : rendererRequire(name),
    document: {
      getElementById: get, body: element(), documentElement: element(),
      querySelector: get, querySelectorAll: () => [], createElement: element, addEventListener() {}
    },
    window: { dstoreqc: api, addEventListener() {}, setTimeout() {}, clearTimeout() {},
      matchMedia: () => ({ matches: false, addEventListener() {} }) },
    localStorage: { getItem() { return null; }, setItem() {} },
    requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {}
  });
  vm.runInContext(renderer, context);
  await Promise.resolve();
  const run = (code) => vm.runInContext(code, context);
  run('selectedFiles = ["a.fastq", "b.fastq"]; appSettings.k = 8;');
  await run("startAnalyzer()");
  return { api, calls, get, run };
}

test("running reads have remove buttons; deletion recounts only the remaining files", async () => {
  const { calls, get, run } = await app();
  assert.match(get("readsFiles").innerHTML, /data-remove-read="0"/);
  assert.match(get("readsFiles").innerHTML, /data-remove-read="1"/);
  run("appSettings.k = 21; appSettings.threads = 12;");
  get("inputsBar").listeners.click({ target: {
    closest: (selector) => selector === "[data-remove-read]" ? { dataset: { removeRead: "0" } } : null
  } });
  await new Promise(setImmediate);
  assert.deepEqual(calls[1].files, ["b.fastq"]);
  assert.equal(calls[1].k, 8, "recount preserves the loaded parameters");
  assert.equal(calls[1].threads, calls[0].threads);
  assert.equal(get("totalCoverage").textContent, "20");
  assert.equal(get("summaryFiles").textContent, "1");
  assert.equal(run("analyzerReady"), true);
});

test("removing the last read stops the kernel and clears counts and cached results", async () => {
  const { calls, get, run } = await app();
  await run("removeSequencingFile(0)");
  run("latestBatch = { rows: [] }; batchRows = [{ index: 0 }]; latestResult = { type: 'sequence' };");
  await run("removeSequencingFile(0)");
  assert.equal(calls.at(-1), "stop");
  assert.equal(calls.length, 3, "empty inputs must not trigger another start or picker");
  assert.equal(run("selectedFiles.length"), 0);
  assert.equal(run("analyzerReady"), false);
  assert.equal(run("latestResult"), null);
  assert.equal(run("latestBatch"), null);
  assert.equal(run("batchRows.length"), 0);
  assert.equal(get("totalCoverage").textContent, "-");
  assert.equal(get("distinctKmers").textContent, "-");
  assert.equal(get("queryButton").disabled, true);
  assert.equal(get("batchSaveButton").disabled, true);
});

test("recount locks read mutations and failures leave old counts unavailable", async () => {
  const { api, get, run } = await app();
  let reject;
  api.startAnalyzer = () => new Promise((_, fail) => { reject = fail; });
  const removing = run("removeSequencingFile(0)");
  assert.match(get("readsFiles").innerHTML, /data-remove-read="0" disabled/);
  assert.equal(get("readsSelectButton").disabled, true);
  assert.equal(get("queryButton").disabled, true);
  assert.equal(get("startButton").disabled, true);
  await run("removeSequencingFile(0)");
  assert.equal(run("selectedFiles.length"), 1);
  reject(new Error("Cannot read b.fastq"));
  await removing;
  assert.equal(run("analyzerReady"), false);
  assert.equal(run("analyzerLoading"), false);
  assert.equal(get("totalCoverage").textContent, "-");
  assert.equal(get("startButton").disabled, false);
  assert.equal(get("statusText").textContent, "Kernel failed to start");
});

test("removal before startup updates the selection without starting a kernel", async () => {
  const { calls, run } = await app();
  run("setAnalyzerReady(false)");
  await run("removeSequencingFile(1)");
  assert.equal(calls.length, 1);
  assert.equal(run("selectedFiles.join(',')"), "a.fastq");
});

test("recount preserves the loaded Bloom reference even when shared inputs changed", async () => {
  const { calls, run } = await app();
  await run(`loadAnalyzer({ files: selectedFiles, k: 8, threads: 2, readLength: 100,
    bloom: true, bloomReference: "original.fa", bloomBits: 16 })`);
  run('referenceFile = "other.fa"; elements.bloomInput.checked = false;');
  await run("removeSequencingFile(1)");
  assert.deepEqual(calls.at(-1), {
    files: ["a.fastq"], k: 8, threads: 2, readLength: 100,
    bloom: true, bloomReference: "original.fa", bloomBits: 16
  });
});

test("a query completing after removal cannot restore a result from the old reads", async () => {
  const { api, get, run } = await app();
  let resolve;
  api.queryAnalyzer = () => new Promise((done) => { resolve = done; });
  run('elements.queryInput.value = "ACGTACGT";');
  const querying = run("runQuery()");
  await run("removeSequencingFile(0)");
  resolve({ type: "error", message: "Old result" });
  await querying;
  assert.equal(run("latestResult.type"), "ready");
  assert.doesNotMatch(get("resultView").textContent, /Old result/);
  assert.equal(get("statusText").textContent, "Kernel running");
});

test("an additional-file count prevents deletion until its updated file set is adopted", async () => {
  const { api, get, run } = await app();
  api.selectFiles = async () => ["c.fastq"];
  let resolve;
  api.addAnalyzerFiles = () => new Promise((done) => { resolve = done; });
  const adding = run("addSequencingFiles()");
  await new Promise(setImmediate);
  assert.equal(get("readsSelectButton").disabled, true);
  await run("removeSequencingFile(0)");
  assert.equal(run("selectedFiles.length"), 2);
  resolve({ type: "summary", files: ["a.fastq", "b.fastq", "c.fastq"],
    k: 8, threads: 3, readLength: 200, distinctKmers: 30, totalKmerCoverage: 60 });
  await adding;
  assert.equal(run("selectedFiles.length"), 3);
  assert.equal(get("readsSelectButton").disabled, false);
  await run("removeSequencingFile(2)");
  assert.equal(get("summaryFiles").textContent, "2");
});

test("Batch QC completing after removal cannot repopulate the cleared cache", async () => {
  const { api, get, run } = await app();
  run('referenceFile = "library.fa";');
  let resolve;
  api.runInteractiveBatch = () => new Promise((done) => { resolve = done; });
  const batching = run("runBatchAnalysis()");
  await run("removeSequencingFile(0)");
  resolve({ rows: [], total: 0, ok: 0, skipped: 0, errors: 0 });
  await batching;
  assert.equal(run("latestBatch"), null);
  assert.equal(run("batchRows.length"), 0);
  assert.equal(get("batchSaveButton").disabled, true);
  assert.match(get("batchResult").textContent, /Reads changed/);
});

test("clear reads stops the kernel and resets selections, counts and cached profiles", async () => {
  const { calls, get, run } = await app();
  run('referenceFile = "encoded.fa"; latestBatch = { rows: [] }; batchRows = [{ index: 0 }];');
  assert.equal(get("clearReadsButton").disabled, false);
  get("clearReadsButton").listeners.click();
  await new Promise(setImmediate);
  assert.equal(calls.at(-1), "stop");
  assert.equal(run("selectedFiles.length"), 0);
  assert.equal(run("referenceFile"), "encoded.fa");
  assert.equal(run("appSettings.k"), 8);
  assert.equal(run("latestResult"), null);
  assert.equal(run("latestBatch"), null);
  assert.equal(run("batchRows.length"), 0);
  assert.equal(get("totalCoverage").textContent, "-");
  assert.equal(get("distinctKmers").textContent, "-");
  assert.equal(get("queryButton").disabled, true);
  assert.equal(get("batchSaveButton").disabled, true);
  assert.equal(get("clearReadsButton").disabled, true);
  assert.equal(get("startButton").disabled, false);
});

for (const operation of ["load", "add"]) {
  for (const outcome of ["resolve", "reject"]) {
    test(`clear during ${operation} ignores its delayed ${outcome} even after a new count starts`, async () => {
      const { api, get, run } = await app();
      const originalStart = api.startAnalyzer;
      let resolve, reject;
      const pending = () => new Promise((done, fail) => { resolve = done; reject = fail; });
      api.selectFiles = async () => ["c.fastq"];
      if (operation === "load") api.startAnalyzer = pending;
      else api.addAnalyzerFiles = pending;
      const counting = run(operation === "load" ? "loadAnalyzer(kernelLoaded.config)" : "addSequencingFiles()");
      await new Promise(setImmediate);
      assert.equal(get("clearReadsButton").disabled, false);
      await run("clearSequencingFiles()");
      api.startAnalyzer = originalStart;
      run('selectedFiles = ["new.fastq"];');
      await run("startAnalyzer()");
      if (outcome === "resolve") resolve({ type: "ready", files: ["old.fastq"], k: 31, threads: 3,
        readLength: 200, distinctKmers: 999, totalKmerCoverage: 999 });
      else reject(new Error("Canceled old count"));
      await counting;
      assert.equal(run("selectedFiles.join(',')"), "new.fastq");
      assert.equal(get("totalCoverage").textContent, "20");
      assert.equal(run("analyzerReady"), true);
      assert.equal(get("statusText").textContent, "Kernel running");
    });
  }
}

test("a file picker opened before clearing cannot restore the read selection", async () => {
  const { api, run } = await app();
  run("setAnalyzerReady(false)");
  let resolve;
  api.selectFiles = () => new Promise((done) => { resolve = done; });
  const selecting = run("selectFiles()");
  await run("clearSequencingFiles()");
  resolve(["old.fastq"]);
  await selecting;
  assert.equal(run("selectedFiles.length"), 0);
});

test("the replaced kernel's delayed exit cannot mark the new kernel as stopped", async () => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const path = require("node:path");
  const children = [];
  const events = [];
  const electron = { app: {
    setName() {}, getPath: () => __dirname, on() {}, whenReady: () => ({ then() {} })
  } };
  const context = vm.createContext({
    exports: {}, process, Buffer, console,
    __dirname: path.dirname(require.resolve("../dist/main.js")),
    setTimeout() {}, clearTimeout() {},
    require(name) {
      if (name === "electron") return electron;
      if (name === "node:child_process") return { spawn() {
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough()
        });
        children.push(child);
        return child;
      } };
      return rendererRequire(name);
    },
    record: (channel, payload) => events.push({ channel, ...payload })
  });
  const run = (code) => vm.runInContext(code, context);
  run(readFileSync(require.resolve("../dist/main.js"), "utf8"));
  run(`ensureAnalyzerBuilt = async () => "";
    mainWindow = { isDestroyed: () => false, webContents: { send: record } };`);
  for (let i = 0; i < 2; i++) {
    const starting = run(`session = new AnalyzerSession();
      session.start({ files: ["reads.fa"], k: 4, threads: 1, readLength: 20 })`);
    await new Promise(setImmediate);
    children[i].stdout.write('{"type":"ready","k":4}\n');
    await starting;
  }
  children[0].emit("close", 0);
  assert.equal(events.filter((event) => event.kind === "exit").length, 0);
  children[1].emit("close", 1);
  assert.equal(events.filter((event) => event.kind === "exit").length, 1,
    "an unexpected exit of the current kernel must still be reported");
  run('var finishBuild; ensureAnalyzerBuilt = () => new Promise((done) => { finishBuild = done; });');
  const canceled = run('session = new AnalyzerSession(); session.start({ files: ["reads.fa"], k: 4, threads: 1, readLength: 20 })');
  run('session.stop(); session = null; finishBuild();');
  await assert.rejects(canceled, /Analyzer session stopped/);
  assert.equal(children.length, 2, "clearing while the binary builds must prevent a later spawn");
});
