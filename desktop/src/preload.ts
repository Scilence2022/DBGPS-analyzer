import { contextBridge, ipcRenderer } from "electron";
import type { AgentProgressEvent, AgentRun, AgentStatus, AgentTraceEvent } from "./agent-types";
import type { AnalyzerConfig, AnalyzerScope, AnalyzerSummaryResult, SequenceSummaryResult } from "./analyzer-config";

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

type AiChatRequest = {
  id: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  context: unknown;
  contextLabel?: string;
  settings: AiSettings;
  mode?: "chat" | "read-only";
  evidenceSnapshotIds?: string[];
};

type AiChatResult = {
  id: string;
  provider: string;
  model: string;
  content: string;
  canceled: boolean;
  agent?: AgentRun;
};

type AiChatChunk = { id: string; delta: string };

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
type DecodabilityRequest = {
  file: string; primerFront: number; indexLength: number; pathLength: number;
  cutoff: number; ratio: number; waive: number[]; extraStep: boolean;
};
type DecodabilityResult = {
  type: "decodability"; datasetVersion: string; file: string; k: number; primerFront: number; indexLength: number; pathLength: number;
  seedKmer: number; pathKmers: number; total: number; ratioFailures: number;
  configs: Array<{ cutoff: number; ratio: number; waive: number[]; extraStep: boolean; decodable: number; failures: Record<string, number> }>;
  ratioHotspots: Array<{ kmer: number; count: number; fraction: number }>;
  rows: Array<{ name: string; failure: string; position: number }>;
};
type BatchSequenceRequest = { file: string; index: number; primerFront?: number; primerBack?: number };
type InteractiveBatchRow = {
  index: number;
  name: string;
  rawLength: number;
  analyzedLength: number;
  status: "ok" | "skipped" | "error";
  message?: string;
  summary?: SequenceSummaryResult;
};
type InteractiveBatchResult = AnalyzerScope & {
  type: "batch";
  datasetVersion: string;
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
  entangled: number; passed: number; skipped: number; entangledNames: string[]; entangledTruncated: boolean;
  filterM: number; filterCommand: string;
  analyzer: { primerLen: number; rows: SmKdKnRow[]; headline: SmKdKnRow | null; command: string } | null;
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
  aiChat: (request: AiChatRequest) => ipcRenderer.invoke("ai:chat", request) as Promise<AiChatResult>,
  cancelAiChat: (id: string) => ipcRenderer.invoke("ai:cancel", id) as Promise<{ ok: boolean }>,
  clearAiEvidence: () => ipcRenderer.invoke("ai:clearEvidence") as Promise<{ ok: boolean }>,
  onAiChatChunk: (callback: (chunk: AiChatChunk) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, chunk: AiChatChunk) => callback(chunk);
    ipcRenderer.on("ai:chunk", listener);
    return () => ipcRenderer.removeListener("ai:chunk", listener);
  },
  onAiTool: (callback: (event: AgentTraceEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentTraceEvent) => callback(payload);
    ipcRenderer.on("ai:tool", listener);
    return () => ipcRenderer.removeListener("ai:tool", listener);
  },
  onAiProgress: (callback: (event: AgentProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AgentProgressEvent) => callback(payload);
    ipcRenderer.on("ai:progress", listener);
    return () => ipcRenderer.removeListener("ai:progress", listener);
  },
  getAgentStatus: () => ipcRenderer.invoke("ai:agentStatus") as Promise<AgentStatus>,
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
  runDecodability: (request: DecodabilityRequest) =>
    ipcRenderer.invoke("analyzer:decodability", request) as Promise<DecodabilityResult>,
  runReport: (request: ReportRequest) => ipcRenderer.invoke("report:run", request) as Promise<ReportResult>,
  saveFile: (request: { defaultName: string; content: string }) =>
    ipcRenderer.invoke("file:save", request) as Promise<{ saved: boolean; path?: string }>,
  onAnalyzerEvent: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("analyzer:event", listener);
    return () => ipcRenderer.removeListener("analyzer:event", listener);
  }
};

contextBridge.exposeInMainWorld("dstoreqc", api);

export type DStoreQCApi = typeof api;
