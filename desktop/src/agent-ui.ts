// DOM-free helpers behind the Desktop Agent panel: conversation threads, readable
// tool-call timelines, slash commands, contextual suggestions, and DNA links.
// Kept pure so they are unit-tested in Node and bundled into the renderer as-is.
import type { AgentStatus, AgentToolTrace } from "./agent-types";

export type ChatMode = "chat" | "agent";

// A tool call as retained in the saved transcript: what was asked and how it
// ended, never the evidence payload itself (that stays in the per-run export).
export type CompactTrace = {
  callId: string;
  name: string;
  arguments: unknown;
  status: AgentToolTrace["status"];
  durationMs?: number;
  facts?: string[];
};

export type ChatMessageMeta = {
  mode: ChatMode;
  provider?: string;
  model?: string;
  contextLabel?: string;
  command?: string;
  stopReason?: string;
  snapshotId?: string;
  trace?: CompactTrace[];
  error?: boolean;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  ts?: number;
  meta?: ChatMessageMeta;
};

export type ChatThread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

export type ThreadStore = { activeId: string; threads: ChatThread[] };

export const THREAD_LIMITS = Object.freeze({ threads: 30, messages: 200, titleChars: 60, traceCalls: 12 });

let threadCounter = 0;

export function createThread(now = Date.now()): ChatThread {
  threadCounter = (threadCounter + 1) % 1e6;
  return { id: `t-${now.toString(36)}-${threadCounter.toString(36)}`, title: "", createdAt: now, updatedAt: now, messages: [] };
}

export function deriveThreadTitle(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === "user" && message.content.trim());
  if (!first) return "";
  const text = first.content.replace(/\s+/g, " ").trim();
  return text.length > THREAD_LIMITS.titleChars ? `${text.slice(0, THREAD_LIMITS.titleChars - 1).trimEnd()}…` : text;
}

function finite(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function normalizeTrace(raw: unknown): CompactTrace[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: CompactTrace[] = [];
  for (const item of raw.slice(0, THREAD_LIMITS.traceCalls)) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.name !== "string" || typeof entry.callId !== "string") continue;
    const status = entry.status === "ok" || entry.status === "error" ? entry.status : "error";
    out.push({
      callId: entry.callId.slice(0, 200),
      name: entry.name.slice(0, 100),
      arguments: entry.arguments ?? {},
      status,
      durationMs: finite(entry.durationMs),
      facts: Array.isArray(entry.facts) ? entry.facts.filter((f): f is string => typeof f === "string").slice(0, 6) : undefined
    });
  }
  return out.length ? out : undefined;
}

function normalizeMeta(raw: unknown): ChatMessageMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const meta = raw as Record<string, unknown>;
  const text = (value: unknown, max = 200) => (typeof value === "string" && value ? value.slice(0, max) : undefined);
  return {
    mode: meta.mode === "agent" ? "agent" : "chat",
    provider: text(meta.provider),
    model: text(meta.model),
    contextLabel: text(meta.contextLabel),
    command: text(meta.command, 40),
    stopReason: text(meta.stopReason, 40),
    snapshotId: text(meta.snapshotId),
    trace: normalizeTrace(meta.trace),
    error: meta.error === true ? true : undefined
  };
}

export function normalizeMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const content = typeof entry.content === "string" ? entry.content : "";
  if (!content.trim()) return null;
  const message: ChatMessage = { role: entry.role === "assistant" ? "assistant" : "user", content };
  const ts = finite(entry.ts);
  if (ts) message.ts = ts;
  const meta = normalizeMeta(entry.meta);
  if (meta) message.meta = meta;
  return message;
}

function normalizeThread(raw: unknown): ChatThread | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== "string" || !entry.id) return null;
  const messages = (Array.isArray(entry.messages) ? entry.messages : [])
    .map(normalizeMessage)
    .filter((m): m is ChatMessage => Boolean(m))
    .slice(-THREAD_LIMITS.messages);
  const createdAt = finite(entry.createdAt) ?? Date.now();
  return {
    id: entry.id.slice(0, 80),
    title: typeof entry.title === "string" ? entry.title.slice(0, THREAD_LIMITS.titleChars + 20) : deriveThreadTitle(messages),
    createdAt,
    updatedAt: finite(entry.updatedAt) ?? createdAt,
    messages
  };
}

// Accept whatever is in storage (current format, a pre-thread flat transcript, or
// garbage) and return a valid store whose active thread exists.
export function normalizeThreadStore(raw: unknown, legacyTranscript?: unknown, now = Date.now()): ThreadStore {
  let threads: ChatThread[] = [];
  let activeId = "";
  if (raw && typeof raw === "object" && Array.isArray((raw as ThreadStore).threads)) {
    threads = (raw as ThreadStore).threads.map(normalizeThread).filter((t): t is ChatThread => Boolean(t));
    activeId = typeof (raw as ThreadStore).activeId === "string" ? (raw as ThreadStore).activeId : "";
  } else if (Array.isArray(legacyTranscript)) {
    const messages = legacyTranscript.map(normalizeMessage).filter((m): m is ChatMessage => Boolean(m)).slice(-THREAD_LIMITS.messages);
    if (messages.length) {
      const thread = createThread(messages[0].ts ?? now);
      thread.messages = messages;
      thread.title = deriveThreadTitle(messages);
      thread.updatedAt = messages[messages.length - 1].ts ?? now;
      threads = [thread];
      activeId = thread.id;
    }
  }
  const seen = new Set<string>();
  threads = threads.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  threads.sort((a, b) => b.updatedAt - a.updatedAt);
  threads = threads.slice(0, THREAD_LIMITS.threads);
  if (!threads.some((t) => t.id === activeId)) {
    const empty = threads.find((t) => t.messages.length === 0);
    if (empty) activeId = empty.id;
    else {
      const thread = createThread(now);
      threads = [thread, ...threads.slice(0, THREAD_LIMITS.threads - 1)];
      activeId = thread.id;
    }
  }
  return { activeId, threads };
}

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 2 * 86_400_000) return "yesterday";
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// --------------------------------------------------------------------------- #
// Tool-call presentation
// --------------------------------------------------------------------------- #
function args(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function plural(n: number, word: string) {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

export const TOOL_LABELS: Record<string, { title: string; icon: string; blurb: string }> = {
  get_analysis_summary: { title: "Read index summary", icon: "database", blurb: "Counts, k, and counting settings of the loaded read index, plus cached Batch QC aggregates." },
  get_sequence_profile: { title: "Read coverage profile", icon: "chart-line", blurb: "Positional k-mer support for a cached Batch QC record or the selected Interactive sequence." },
  query_kmer: { title: "Query k-mer neighborhood", icon: "git-fork", blurb: "Count and membership-derived neighbors of one k-mer at the loaded k." },
  get_batch_rows: { title: "Read Batch QC rows", icon: "table-2", blurb: "Paginated per-strand rows from the completed Batch QC cache." }
};

export function describeToolCall(name: string, input: unknown): { title: string; detail: string; icon: string } {
  const label = TOOL_LABELS[name];
  const a = args(input);
  if (!label) return { title: name, detail: "Not in the read-only allowlist", icon: "circle-help" };
  switch (name) {
    case "get_sequence_profile": {
      const record = int(a.recordIndex);
      const offset = int(a.offset) ?? 0;
      const limit = int(a.limit) ?? 0;
      const target = record == null ? "selected Interactive sequence" : `record ${record} (row #${record + 1})`;
      return { ...label, detail: `${target} · windows ${offset}–${offset + Math.max(0, limit - 1)}` };
    }
    case "query_kmer": {
      const kmer = typeof a.kmer === "string" ? a.kmer.toUpperCase() : "?";
      return { ...label, detail: `${kmer.length > 18 ? `${kmer.slice(0, 8)}…${kmer.slice(-8)}` : kmer} · depth ${int(a.depth) ?? 0}` };
    }
    case "get_batch_rows": {
      const offset = int(a.offset) ?? 0;
      const limit = int(a.limit) ?? 0;
      const status = typeof a.status === "string" ? a.status : "all";
      return { ...label, detail: `${status} · rows ${offset + 1}–${offset + limit}` };
    }
    default:
      return { ...label, detail: "loaded index" };
  }
}

function payload(result: unknown): Record<string, unknown> | null {
  const r = args(result);
  if (r.ok !== true) return null;
  return args(r.data);
}

// A few short, deterministic facts lifted from a tool result for the timeline.
export function toolResultFacts(name: string, result: unknown): string[] {
  const r = args(result);
  if (r.ok === false) return [typeof r.error === "string" ? r.error.slice(0, 160) : "Query failed; no evidence adopted."];
  const data = payload(result);
  if (!data) return [];
  const facts: string[] = [];
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  switch (name) {
    case "get_analysis_summary": {
      const k = num(data.k);
      const distinct = num(data.distinctKmers);
      if (k != null) facts.push(`k = ${k}`);
      if (distinct != null) facts.push(`${distinct.toLocaleString("en-US")} distinct k-mers`);
      const batch = args(data.batch);
      const total = num(batch.total);
      if (total != null) facts.push(`batch: ${num(batch.complete) ?? 0}/${total} complete`);
      if (data.indexScope === "reference") facts.push("reference scope");
      break;
    }
    case "get_sequence_profile": {
      const slice = args(data.coverageSlice);
      const positions = Array.isArray(slice.positions) ? slice.positions.map(args) : [];
      const values = positions.map((p) => num(p.coverage)).filter((v): v is number => v != null);
      const total = num(slice.total);
      if (total != null) facts.push(`${positions.length} of ${total} windows`);
      if (values.length) {
        const zero = values.filter((v) => v === 0).length;
        facts.push(`min ${Math.min(...values)} · max ${Math.max(...values)}`);
        if (zero) facts.push(`${plural(zero, "zero-support window")}`);
      }
      break;
    }
    case "query_kmer": {
      const coverage = num(data.coverage);
      if (coverage != null) facts.push(`coverage ${coverage}`);
      const inDeg = num(data.inDegree);
      const outDeg = num(data.outDegree);
      if (inDeg != null && outDeg != null) facts.push(`in ${inDeg} · out ${outDeg}`);
      break;
    }
    case "get_batch_rows": {
      const selection = args(data.selection);
      const matched = num(selection.matchedTotal);
      const rows = Array.isArray(data.rows) ? data.rows.length : 0;
      if (matched != null) facts.push(`${plural(matched, "matching row")}`);
      if (rows) facts.push(`${rows} returned`);
      break;
    }
  }
  return facts;
}

// Coverage values of a profile slice, for the inline sparkline.
export function profileSeries(result: unknown): Array<{ position: number; coverage: number }> | null {
  const data = payload(result);
  if (!data) return null;
  const slice = args(data.coverageSlice);
  if (!Array.isArray(slice.positions)) return null;
  const series = slice.positions
    .map(args)
    .filter((p) => typeof p.position === "number" && typeof p.coverage === "number")
    .map((p) => ({ position: p.position as number, coverage: p.coverage as number }));
  return series.length ? series : null;
}

export type ToolTarget = { kind: "batch-record"; index: number } | { kind: "kmer"; kmer: string };

// Deterministic jump targets taken from tool arguments and results (never from
// the model's prose), so "Open in Batch QC" always points at what was measured.
export function toolTargets(trace: { name: string; arguments: unknown; result?: unknown }, maxRows = 5): ToolTarget[] {
  const a = args(trace.arguments);
  if (trace.name === "get_sequence_profile") {
    const record = int(a.recordIndex);
    return record == null ? [] : [{ kind: "batch-record", index: record }];
  }
  if (trace.name === "query_kmer" && typeof a.kmer === "string" && /^[ACGTacgt]+$/.test(a.kmer)) {
    return [{ kind: "kmer", kmer: a.kmer.toUpperCase() }];
  }
  if (trace.name === "get_batch_rows") {
    const data = payload(trace.result);
    const rows = data && Array.isArray(data.rows) ? data.rows.map(args) : [];
    return rows
      .map((row) => int(row.index))
      .filter((index): index is number => index != null)
      .slice(0, maxRows)
      .map((index) => ({ kind: "batch-record", index }));
  }
  return [];
}

export function compactTrace(trace: AgentToolTrace[]): CompactTrace[] {
  return trace.slice(0, THREAD_LIMITS.traceCalls).map((item) => {
    const start = Date.parse(item.startedAt);
    const end = item.finishedAt ? Date.parse(item.finishedAt) : NaN;
    return {
      callId: item.callId,
      name: item.name,
      arguments: item.arguments,
      status: item.status === "running" ? "error" : item.status,
      durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined,
      facts: toolResultFacts(item.name, item.result)
    };
  });
}

// --------------------------------------------------------------------------- #
// Slash commands
// --------------------------------------------------------------------------- #
export type SlashAction = "new" | "export" | "mode-agent" | "mode-chat";

export type SlashCommand = {
  name: string;
  description: string;
  prompt?: string;
  mode?: ChatMode;
  action?: SlashAction;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "triage", mode: "agent",
    description: "Find and explain the Batch QC strands that are not complete",
    prompt: "Triage the Batch QC strands that are not complete. List them with their key metrics, inspect the coverage profiles of up to three of the worst, and for each say whether the evidence points at a localized dropout, uniformly low depth, or something the index cannot measure. End with concrete manual checks."
  },
  {
    name: "summary", mode: "agent",
    description: "Summarize the loaded index, cached batch, and active view",
    prompt: "Summarize the current analysis state: the loaded read index, the cached Batch QC aggregates, and what the active view shows. Cite the numbers you use and say what is not loaded."
  },
  {
    name: "explain", mode: "chat",
    description: "Explain the result in the active view",
    prompt: "Explain the result in the active view: what each metric means here, which values are healthy, marginal, or poor by the app's bands, and what they imply."
  },
  {
    name: "next", mode: "chat",
    description: "Recommend what to check next",
    prompt: "Given the current results, what should I check next and why? Rank up to three concrete steps I can take in DStoreQC."
  },
  {
    name: "metrics", mode: "chat",
    description: "Sm, Kd, Kn and the app's health bands",
    prompt: "What do Sm, Kd and Kn measure, how are they computed in DStoreQC, and what are the healthy, marginal, and poor bands?"
  },
  {
    name: "methods", mode: "chat",
    description: "Draft a methods paragraph for the current analysis",
    prompt: "Draft a short, factual methods-style paragraph describing the analysis in the current context (tools, k, primer trimming, thresholds). Do not report any number that is not in the context."
  },
  { name: "agent", action: "mode-agent", description: "Switch to Agent mode (read-only tools)" },
  { name: "chat", action: "mode-chat", description: "Switch to Chat mode (text only)" },
  { name: "new", action: "new", description: "Start a new conversation" },
  { name: "export", action: "export", description: "Export this conversation as Markdown" }
];

// Commands offered while the composer holds only "/partial" (no space yet).
export function matchSlashCommands(input: string): SlashCommand[] {
  const match = /^\/([a-z]*)$/i.exec(input.trimStart());
  if (!match) return [];
  const query = match[1].toLowerCase();
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(query));
}

// A complete "/name extra text" message. Extra text is appended to the template
// so "/explain focus on the 3' end" still sends the full instruction.
export function parseSlashCommand(input: string): { command: SlashCommand; prompt: string } | null {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(input.trim());
  if (!match) return null;
  const command = SLASH_COMMANDS.find((c) => c.name === match[1].toLowerCase());
  if (!command) return null;
  const extra = (match[2] || "").trim();
  const prompt = command.prompt ? (extra ? `${command.prompt}\n\nAdditional focus: ${extra}` : command.prompt) : extra;
  return { command, prompt };
}

// --------------------------------------------------------------------------- #
// Suggestions shown above the composer
// --------------------------------------------------------------------------- #
export type Suggestion = { label: string; prompt: string; mode?: ChatMode };

function fromCommand(name: string, label: string): Suggestion {
  const command = SLASH_COMMANDS.find((c) => c.name === name)!;
  return { label, prompt: command.prompt || "", mode: command.mode };
}

export function agentSuggestions(contextLabel: string | null, status: AgentStatus | null, limit = 4): Suggestion[] {
  const out: Suggestion[] = [];
  const batch = status?.batch;
  if (batch && batch.incomplete + batch.errors > 0) {
    out.push(fromCommand("triage", `Triage ${plural(batch.incomplete + batch.errors, "incomplete strand")}`));
  }
  if (contextLabel) out.push(fromCommand("explain", `Explain this ${contextLabel}`));
  if (status?.datasetVersion) out.push(fromCommand("summary", batch ? "Summarize index and batch" : "Summarize the loaded index"));
  if (!status?.datasetVersion) {
    out.push({ label: "How do I start an analysis?", prompt: "How do I load sequencing reads, start the kernel, and run a Batch QC scan in DStoreQC?", mode: "chat" });
  }
  out.push(fromCommand("next", "What should I check next?"));
  out.push(fromCommand("metrics", "What do Sm, Kd and Kn mean?"));
  if (!contextLabel) out.push({ label: "Cross-links vs entanglement", prompt: "What are cross-links and entanglement in a DNA storage library, and how does DStoreQC measure them?", mode: "chat" });
  return out.slice(0, limit);
}

// --------------------------------------------------------------------------- #
// Actionable DNA in rendered Markdown
// --------------------------------------------------------------------------- #
// Turn inline code spans that are pure DNA into buttons that open the sequence in
// Interactive. Operates on the renderer's own escaped HTML; fenced blocks are left
// alone. The captured text is [ACGT] only, so it is safe to reuse in attributes.
export function linkifyDnaCode(html: string, minLength: number): string {
  const min = Math.max(4, Math.trunc(minLength) || 4);
  const pattern = new RegExp(`(?<!<pre class="md-code">)<code>([ACGTacgt]{${min},})</code>`, "g");
  return html.replace(pattern, (_m, dna: string) =>
    `<code class="dna-link" role="button" tabindex="0" data-dna="${dna.toUpperCase()}" title="Open in Interactive">${dna}</code>`);
}
