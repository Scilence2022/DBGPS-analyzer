import { contextBridge, ipcRenderer } from "electron";

type AnalyzerConfig = {
  files: string[];
  k: number;
  threads: number;
  readLength: number;
};

type AiRequest = {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  context: unknown;
};

const api = {
  selectFiles: () => ipcRenderer.invoke("analyzer:selectFiles") as Promise<string[]>,
  buildAnalyzer: () => ipcRenderer.invoke("analyzer:build") as Promise<{ ok: boolean; log: string }>,
  startAnalyzer: (config: AnalyzerConfig) => ipcRenderer.invoke("analyzer:start", config) as Promise<unknown>,
  queryAnalyzer: (command: string) => ipcRenderer.invoke("analyzer:query", command) as Promise<unknown>,
  stopAnalyzer: () => ipcRenderer.invoke("analyzer:stop") as Promise<{ ok: boolean }>,
  aiDiagnose: (request: AiRequest) => ipcRenderer.invoke("ai:diagnose", request) as Promise<{ content: string; provider: string }>,
  onAnalyzerEvent: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("analyzer:event", listener);
    return () => ipcRenderer.removeListener("analyzer:event", listener);
  }
};

contextBridge.exposeInMainWorld("dbgps", api);

export type DbgpsApi = typeof api;
