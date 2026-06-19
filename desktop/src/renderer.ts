import { createIcons, icons } from "lucide";
import type { DbgpsApi } from "./preload";

declare global {
  interface Window {
    dbgps: DbgpsApi;
  }
}

type Neighbor = {
  base: string;
  kmer: string;
  coverage: number;
  present: boolean;
};

type KmerResult = {
  type: "kmer";
  query: string;
  canonical: string;
  coverage: number;
  upstream: Neighbor[];
  downstream: Neighbor[];
  inDegree: number;
  outDegree: number;
};

type SequenceCoverage = {
  position: number;
  kmer: string;
  canonical: string;
  coverage: number;
};

type SequenceResult = {
  type: "sequence";
  length: number;
  k: number;
  kmerCount: number;
  observed: number;
  missing: number;
  complete: boolean;
  minCoverage: number;
  maxCoverage: number;
  meanCoverage: number;
  maxAdjacentRatio: number;
  coverages: SequenceCoverage[];
  ratios: Array<{ position: number; ratio: number }>;
};

type SummaryResult = {
  type: "ready" | "summary";
  k: number;
  files?: string[];
  distinctKmers: number;
  totalKmerCoverage: number;
};

type AnalyzerResult = KmerResult | SequenceResult | SummaryResult | { type: "error"; message: string };

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const elements = {
  statusText: $("statusText"),
  buildButton: $("buildButton") as HTMLButtonElement,
  stopButton: $("stopButton") as HTMLButtonElement,
  themeButton: $("themeButton") as HTMLButtonElement,
  selectFilesButton: $("selectFilesButton") as HTMLButtonElement,
  fileList: $("fileList"),
  kInput: $("kInput") as HTMLInputElement,
  threadsInput: $("threadsInput") as HTMLInputElement,
  readLengthInput: $("readLengthInput") as HTMLInputElement,
  startButton: $("startButton") as HTMLButtonElement,
  queryButton: $("queryButton") as HTMLButtonElement,
  queryInput: $("queryInput") as HTMLTextAreaElement,
  resultView: $("resultView"),
  logView: $("logView"),
  distinctKmers: $("distinctKmers"),
  totalCoverage: $("totalCoverage"),
  summaryK: $("summaryK"),
  summaryFiles: $("summaryFiles"),
  chatMessages: $("chatMessages"),
  chatInput: $("chatInput") as HTMLTextAreaElement,
  sendChatButton: $("sendChatButton") as HTMLButtonElement,
  aiProvider: $("aiProvider")
};

let selectedFiles: string[] = [];
let analyzerReady = false;
let queryMode: "kmer" | "sequence" = "kmer";
let latestResult: AnalyzerResult | null = null;
const chatMessages: ChatMessage[] = [];

function renderIcons() {
  createIcons({ icons });
}

function escapeHtml(value: unknown) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "-";
  return new Intl.NumberFormat("en-US").format(parsed);
}

function compactPath(file: string) {
  const parts = file.split(/[\\/]/);
  if (parts.length <= 3) return file;
  return `${parts.at(-3)}/${parts.at(-2)}/${parts.at(-1)}`;
}

function setStatus(text: string, state: "idle" | "running" | "error" = "idle") {
  elements.statusText.textContent = text;
  document.body.dataset.status = state;
}

function appendLog(text: string) {
  const normalized = text.trim();
  if (!normalized) return;
  const now = new Date().toLocaleTimeString();
  elements.logView.textContent += `[${now}] ${normalized}\n`;
  elements.logView.scrollTop = elements.logView.scrollHeight;
}

function setTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("dbgps-theme", theme);
  elements.themeButton.innerHTML = theme === "dark" ? '<i data-lucide="sun"></i>' : '<i data-lucide="moon"></i>';
  renderIcons();
}

function renderFileList() {
  if (selectedFiles.length === 0) {
    elements.fileList.textContent = "No files selected";
    return;
  }
  elements.fileList.innerHTML = selectedFiles
    .map((file) => `<span title="${escapeHtml(file)}">${escapeHtml(compactPath(file))}</span>`)
    .join("");
}

function renderSummary(data: SummaryResult) {
  elements.distinctKmers.textContent = formatNumber(data.distinctKmers);
  elements.totalCoverage.textContent = formatNumber(data.totalKmerCoverage);
  elements.summaryK.textContent = formatNumber(data.k);
  elements.summaryFiles.textContent = formatNumber(data.files?.length ?? selectedFiles.length);
}

function coverageClass(coverage: number) {
  if (coverage <= 0) return "zero";
  if (coverage < 3) return "low";
  return "ok";
}

function renderNeighborTable(title: string, neighbors: Neighbor[]) {
  return `
    <div class="neighbor-block">
      <h3>${escapeHtml(title)}</h3>
      <div class="neighbor-list">
        ${neighbors
          .map(
            (node) => `
              <div class="neighbor-row ${node.present ? "present" : "missing"}">
                <span class="base">${escapeHtml(node.base)}</span>
                <code>${escapeHtml(node.kmer)}</code>
                <span class="coverage ${coverageClass(node.coverage)}">${formatNumber(node.coverage)}</span>
              </div>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderKmerResult(data: KmerResult) {
  elements.resultView.className = "result-view";
  elements.resultView.innerHTML = `
    <div class="result-grid">
      <div class="focus-kmer">
        <span>Query</span>
        <code>${escapeHtml(data.query)}</code>
        <strong class="coverage ${coverageClass(data.coverage)}">${formatNumber(data.coverage)}</strong>
      </div>
      <div class="metric">
        <span>Canonical</span>
        <strong>${escapeHtml(data.canonical)}</strong>
      </div>
      <div class="metric">
        <span>In degree</span>
        <strong>${formatNumber(data.inDegree)}</strong>
      </div>
      <div class="metric">
        <span>Out degree</span>
        <strong>${formatNumber(data.outDegree)}</strong>
      </div>
    </div>
    <div class="neighbor-grid">
      ${renderNeighborTable("Upstream k-mers", data.upstream)}
      ${renderNeighborTable("Downstream k-mers", data.downstream)}
    </div>
  `;
}

function renderCoverageBars(data: SequenceResult) {
  const maxCoverage = Math.max(1, ...data.coverages.map((item) => item.coverage));
  const shown = data.coverages.slice(0, 180);
  return `
    <div class="coverage-bars" aria-label="k-mer coverage">
      ${shown
        .map((item) => {
          const height = Math.max(4, Math.round((item.coverage / maxCoverage) * 100));
          return `<span class="${coverageClass(item.coverage)}" style="--h:${height}%" title="${escapeHtml(item.position)} ${escapeHtml(item.kmer)} cov=${escapeHtml(item.coverage)}"></span>`;
        })
        .join("")}
    </div>
    ${data.coverages.length > shown.length ? `<p class="table-note">Showing the first ${shown.length} of ${data.coverages.length} k-mers.</p>` : ""}
  `;
}

function renderSequenceTable(data: SequenceResult) {
  const rows = data.coverages.slice(0, 220);
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Position</th>
            <th>k-mer</th>
            <th>Canonical</th>
            <th>Coverage</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (item) => `
                <tr class="${item.coverage === 0 ? "missing-row" : ""}">
                  <td>${formatNumber(item.position)}</td>
                  <td><code>${escapeHtml(item.kmer)}</code></td>
                  <td><code>${escapeHtml(item.canonical)}</code></td>
                  <td><span class="coverage ${coverageClass(item.coverage)}">${formatNumber(item.coverage)}</span></td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderSequenceResult(data: SequenceResult) {
  elements.resultView.className = "result-view";
  elements.resultView.innerHTML = `
    <div class="result-grid">
      <div class="metric ${data.complete ? "metric-ok" : "metric-alert"}">
        <span>Path</span>
        <strong>${data.complete ? "Complete" : "Broken"}</strong>
      </div>
      <div class="metric">
        <span>Observed</span>
        <strong>${formatNumber(data.observed)} / ${formatNumber(data.kmerCount)}</strong>
      </div>
      <div class="metric">
        <span>Min / Max</span>
        <strong>${formatNumber(data.minCoverage)} / ${formatNumber(data.maxCoverage)}</strong>
      </div>
      <div class="metric">
        <span>Max ratio</span>
        <strong>${Number(data.maxAdjacentRatio).toFixed(3)}</strong>
      </div>
    </div>
    ${renderCoverageBars(data)}
    ${renderSequenceTable(data)}
  `;
}

function renderResult(result: AnalyzerResult) {
  latestResult = result;
  if (result.type === "error") {
    elements.resultView.className = "result-view empty-state error-text";
    elements.resultView.textContent = result.message;
    return;
  }
  if (result.type === "kmer") renderKmerResult(result);
  else if (result.type === "sequence") renderSequenceResult(result);
  else renderSummary(result);
  renderIcons();
}

function setAnalyzerReady(ready: boolean) {
  analyzerReady = ready;
  elements.queryButton.disabled = !ready;
  elements.stopButton.disabled = !ready;
  elements.startButton.disabled = ready;
}

async function selectFiles() {
  selectedFiles = await window.dbgps.selectFiles();
  renderFileList();
}

async function buildAnalyzer() {
  elements.buildButton.disabled = true;
  setStatus("Building C kernel", "running");
  try {
    const result = await window.dbgps.buildAnalyzer();
    appendLog(result.log || "DBGPS-analyzer is up to date.");
    setStatus("Build complete");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(message);
    setStatus("Build failed", "error");
  } finally {
    elements.buildButton.disabled = false;
  }
}

async function startAnalyzer() {
  if (selectedFiles.length === 0) await selectFiles();
  if (selectedFiles.length === 0) return;

  setAnalyzerReady(false);
  setStatus("Loading sequencing k-mer table", "running");
  elements.startButton.disabled = true;

  try {
    const ready = (await window.dbgps.startAnalyzer({
      files: selectedFiles,
      k: Number(elements.kInput.value),
      threads: Number(elements.threadsInput.value),
      readLength: Number(elements.readLengthInput.value)
    })) as SummaryResult;
    renderSummary(ready);
    latestResult = ready;
    setAnalyzerReady(true);
    setStatus("Kernel running", "running");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(message);
    setStatus("Kernel failed to start", "error");
    setAnalyzerReady(false);
    elements.startButton.disabled = false;
  }
}

async function stopAnalyzer() {
  await window.dbgps.stopAnalyzer();
  setAnalyzerReady(false);
  elements.startButton.disabled = false;
  setStatus("Kernel stopped");
}

function buildQueryCommand() {
  const input = elements.queryInput.value.trim().replace(/\s+/g, "");
  if (!input) return "";
  return queryMode === "kmer" ? `kmer ${input}` : `sequence ${input}`;
}

async function runQuery() {
  const command = buildQueryCommand();
  if (!command) return;
  elements.queryButton.disabled = true;
  setStatus("Querying", "running");
  try {
    const result = (await window.dbgps.queryAnalyzer(command)) as AnalyzerResult;
    renderResult(result);
    setStatus("Kernel running", "running");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    renderResult({ type: "error", message });
    setStatus("Query failed", "error");
  } finally {
    elements.queryButton.disabled = !analyzerReady;
  }
}

function appendChat(role: "user" | "assistant", content: string) {
  chatMessages.push({ role, content });
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = content;
  elements.chatMessages.appendChild(div);
  elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

async function sendChat() {
  const question = elements.chatInput.value.trim();
  if (!question) return;
  appendChat("user", question);
  elements.chatInput.value = "";
  elements.sendChatButton.disabled = true;
  try {
    const result = await window.dbgps.aiDiagnose({
      messages: chatMessages,
      context: latestResult
    });
    elements.aiProvider.textContent = result.provider;
    appendChat("assistant", result.content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendChat("assistant", `Diagnosis failed: ${message}`);
  } finally {
    elements.sendChatButton.disabled = false;
  }
}

function initializeTheme() {
  const saved = localStorage.getItem("dbgps-theme");
  if (saved === "light" || saved === "dark") {
    setTheme(saved);
  } else {
    setTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
}

document.querySelectorAll<HTMLButtonElement>(".segmented button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".segmented button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    queryMode = button.dataset.mode === "sequence" ? "sequence" : "kmer";
  });
});

elements.selectFilesButton.addEventListener("click", selectFiles);
elements.buildButton.addEventListener("click", buildAnalyzer);
elements.startButton.addEventListener("click", startAnalyzer);
elements.stopButton.addEventListener("click", stopAnalyzer);
elements.queryButton.addEventListener("click", runQuery);
elements.sendChatButton.addEventListener("click", sendChat);
elements.themeButton.addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

elements.queryInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") runQuery();
});

elements.chatInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") sendChat();
});

window.dbgps.onAnalyzerEvent((event) => {
  const payload = event as { kind?: string; line?: string; code?: number };
  if (payload.kind === "stderr" && payload.line) appendLog(payload.line);
  if (payload.kind === "exit") {
    setAnalyzerReady(false);
    elements.startButton.disabled = false;
    setStatus(`Kernel exited: ${payload.code ?? ""}`.trim());
  }
});

initializeTheme();
renderFileList();
renderIcons();
