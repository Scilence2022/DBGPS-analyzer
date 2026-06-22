import { contextBridge, ipcRenderer } from "electron";

type AnalyzerConfig = {
  files: string[];
  k: number;
  threads: number;
  readLength: number;
};

type AnalyzerSummaryResult = {
  type: "ready" | "summary";
  k: number;
  distinctKmers: number;
  totalKmerCoverage: number;
  files?: string[];
};

type ProviderId =
  | "openai"
  | "google"
  | "anthropic"
  | "glm"
  | "kimi"
  | "deepseek"
  | "minimax-local"
  | "minimax-global"
  | "siliconflow"
  | "openrouter"
  | "local"
  | "custom";

type AiSettings = {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
};

type ProviderRefreshRequest = {
  provider: ProviderId;
  apiKey?: string;
  baseUrl?: string;
};

type AiRequest = {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  context: unknown;
  settings: AiSettings;
};

type LinksRequest = { file: string; k?: number; m?: number; primerLen?: number };
type LinksResult = {
  command: string; stdout: string; stderr: string; code: number | null;
  file: string; k: number; m: number; primerLen: number; crossLinks: number | null;
};

type FilterRequest = { file: string; k?: number; m?: number; primerLen?: number; listFiltered?: boolean };
type FilterResult = {
  command: string; stdout: string; stderr: string; code: number | null;
  file: string; k: number; m: number; primerLen: number; listFiltered: boolean;
  passedCount: number; filteredCount: number; skippedCount: number;
  saveOutput: string; saveDefaultName: string;
};

type SmKdKnRow = {
  ratio: number; coverage: number; total: number; paths: number; noise: number;
  exist: number; lost: number; sm: number; kd: number; kn: number;
};
type AnalyzerBatchRequest = {
  strandsFile: string; ngsFiles: string[];
  k?: number; threads?: number; readLength?: number;
  minCov?: number; maxCov?: number; ratio?: number; maxR?: number; step?: number; skip?: number;
};
type AnalyzerBatchResult = {
  command: string; stdout: string; stderr: string; code: number | null;
  k: number; rows: SmKdKnRow[];
};
type InteractiveBatchRequest = { file: string; primerFront?: number; primerBack?: number };
type BatchSequenceRequest = { file: string; index: number; primerFront?: number; primerBack?: number };
type SequenceSummary = {
  type: "sequenceSummary";
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
};
type InteractiveBatchRow = {
  index: number;
  name: string;
  rawLength: number;
  analyzedLength: number;
  status: "ok" | "skipped" | "error";
  message?: string;
  summary?: SequenceSummary;
};
type InteractiveBatchResult = {
  type: "batch";
  file: string;
  k: number;
  primerFront: number;
  primerBack: number;
  total: number;
  ok: number;
  skipped: number;
  errors: number;
  rows: InteractiveBatchRow[];
};

type ReportRequest = {
  referenceFile: string; ngsFiles?: string[];
  k?: number; threads?: number; readLength?: number;
  primerLen?: number; linksM?: number; filterM?: number;
};
type ReportResult = {
  generatedAt: string; referenceFile: string; ngsFiles: string[];
  k: number; primerLen: number; totalStrands: number;
  crossLinks: number | null; linksM: number; linksCommand: string;
  entangled: number; passed: number; entangledNames: string[]; entangledTruncated: boolean;
  filterM: number; filterCommand: string;
  analyzer: { rows: SmKdKnRow[]; headline: SmKdKnRow | null; command: string } | null;
};

const api = {
  selectFiles: () => ipcRenderer.invoke("analyzer:selectFiles") as Promise<string[]>,
  buildAnalyzer: () => ipcRenderer.invoke("analyzer:build") as Promise<{ ok: boolean; log: string }>,
  startAnalyzer: (config: AnalyzerConfig) => ipcRenderer.invoke("analyzer:start", config) as Promise<unknown>,
  addAnalyzerFiles: (files: string[]) =>
    ipcRenderer.invoke("analyzer:addFiles", files) as Promise<AnalyzerSummaryResult>,
  queryAnalyzer: (command: string) => ipcRenderer.invoke("analyzer:query", command) as Promise<unknown>,
  queryAnalyzerBatch: (commands: string[]) =>
    ipcRenderer.invoke("analyzer:queryBatch", commands) as Promise<unknown[]>,
  stopAnalyzer: () => ipcRenderer.invoke("analyzer:stop") as Promise<{ ok: boolean }>,
  aiDiagnose: (request: AiRequest) => ipcRenderer.invoke("ai:diagnose", request) as Promise<{ content: string; provider: string; model: string }>,
  refreshProviderModels: (request: ProviderRefreshRequest) =>
    ipcRenderer.invoke("ai:refreshModels", request) as Promise<{ models: string[]; provider: string; source: string }>,
  loadSecrets: () => ipcRenderer.invoke("secrets:load") as Promise<Record<string, string>>,
  saveSecrets: (map: Record<string, string>) =>
    ipcRenderer.invoke("secrets:save", map) as Promise<{ ok: boolean; encrypted: boolean }>,
  parseSequences: (file: string) =>
    ipcRenderer.invoke("sequence:parse", file) as Promise<Array<{ name: string; seq: string }>>,
  loadBatchSequence: (request: BatchSequenceRequest) =>
    ipcRenderer.invoke("sequence:batchRecord", request) as Promise<{ index: number; name: string; rawLength: number; analyzedLength: number; seq: string }>,
  runLinks: (request: LinksRequest) => ipcRenderer.invoke("links:run", request) as Promise<LinksResult>,
  runFilter: (request: FilterRequest) => ipcRenderer.invoke("filter:run", request) as Promise<FilterResult>,
  runAnalyzerBatch: (request: AnalyzerBatchRequest) =>
    ipcRenderer.invoke("analyzer:runBatch", request) as Promise<AnalyzerBatchResult>,
  runInteractiveBatch: (request: InteractiveBatchRequest) =>
    ipcRenderer.invoke("analyzer:runInteractiveBatch", request) as Promise<InteractiveBatchResult>,
  runReport: (request: ReportRequest) => ipcRenderer.invoke("report:run", request) as Promise<ReportResult>,
  saveFile: (request: { defaultName: string; content: string }) =>
    ipcRenderer.invoke("file:save", request) as Promise<{ saved: boolean; path?: string }>,
  onAnalyzerEvent: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("analyzer:event", listener);
    return () => ipcRenderer.removeListener("analyzer:event", listener);
  }
};

contextBridge.exposeInMainWorld("dbgps", api);

export type DbgpsApi = typeof api;
