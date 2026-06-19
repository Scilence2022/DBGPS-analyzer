import { contextBridge, ipcRenderer } from "electron";

type AnalyzerConfig = {
  files: string[];
  k: number;
  threads: number;
  readLength: number;
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

const api = {
  selectFiles: () => ipcRenderer.invoke("analyzer:selectFiles") as Promise<string[]>,
  buildAnalyzer: () => ipcRenderer.invoke("analyzer:build") as Promise<{ ok: boolean; log: string }>,
  startAnalyzer: (config: AnalyzerConfig) => ipcRenderer.invoke("analyzer:start", config) as Promise<unknown>,
  queryAnalyzer: (command: string) => ipcRenderer.invoke("analyzer:query", command) as Promise<unknown>,
  stopAnalyzer: () => ipcRenderer.invoke("analyzer:stop") as Promise<{ ok: boolean }>,
  aiDiagnose: (request: AiRequest) => ipcRenderer.invoke("ai:diagnose", request) as Promise<{ content: string; provider: string; model: string }>,
  refreshProviderModels: (request: ProviderRefreshRequest) =>
    ipcRenderer.invoke("ai:refreshModels", request) as Promise<{ models: string[]; provider: string; source: string }>,
  onAnalyzerEvent: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("analyzer:event", listener);
    return () => ipcRenderer.removeListener("analyzer:event", listener);
  }
};

contextBridge.exposeInMainWorld("dbgps", api);

export type DbgpsApi = typeof api;
