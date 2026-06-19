import { app, BrowserWindow, dialog, ipcMain, nativeTheme, type OpenDialogOptions } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { existsSync } from "node:fs";
import path from "node:path";

type AnalyzerConfig = {
  files: string[];
  k: number;
  threads: number;
  readLength: number;
};

type PendingQuery = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

let mainWindow: BrowserWindow | null = null;
let session: AnalyzerSession | null = null;

const repoRoot = path.resolve(__dirname, "..", "..");
const analyzerPath = path.join(repoRoot, "DBGPS-analyzer");

function sendWindow(channel: string, payload: unknown) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function toPositiveInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function runMake(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("make", ["DBGPS-analyzer"], { cwd: repoRoot });
    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(output || `make DBGPS-analyzer failed with code ${code}`));
    });
  });
}

async function ensureAnalyzerBuilt(force = false) {
  if (!force && existsSync(analyzerPath)) return "";
  return runMake();
}

class AnalyzerSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdout: Interface | null = null;
  private pending: PendingQuery[] = [];
  private ready = false;

  async start(config: AnalyzerConfig) {
    await ensureAnalyzerBuilt(false);

    const k = toPositiveInt(config.k, 31, 1, 31);
    const threads = toPositiveInt(config.threads, 3, 1, 64);
    const readLength = toPositiveInt(config.readLength, 200, k, 100000);
    const files = Array.isArray(config.files) ? config.files.filter((file) => typeof file === "string" && file.length > 0) : [];
    if (files.length === 0) throw new Error("Select at least one NGS FASTA/FASTQ file.");

    const args = ["-i", "-k", String(k), "-t", String(threads), "-L", String(readLength), ...files];

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Analyzer did not become ready within 120 seconds."));
        this.stop();
      }, 120000);

      this.child = spawn(analyzerPath, args, { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
      this.stdout = createInterface({ input: this.child.stdout });

      this.stdout.on("line", (line) => {
        let payload: unknown;
        try {
          payload = JSON.parse(line);
        } catch {
          sendWindow("analyzer:event", { kind: "stdout", line });
          return;
        }

        const typed = payload as { type?: string; message?: string };
        if (!this.ready) {
          if (typed.type === "ready") {
            this.ready = true;
            clearTimeout(timeout);
            if (!settled) {
              settled = true;
              resolve(payload);
            }
            sendWindow("analyzer:event", { kind: "ready", payload });
            return;
          }
          if (typed.type === "error") {
            clearTimeout(timeout);
            if (!settled) {
              settled = true;
              reject(new Error(typed.message || "Analyzer failed to start."));
            }
            return;
          }
        }

        const query = this.pending.shift();
        if (query) {
          clearTimeout(query.timer);
          query.resolve(payload);
        } else {
          sendWindow("analyzer:event", { kind: "data", payload });
        }
      });

      this.child.stderr.on("data", (chunk: Buffer) => {
        sendWindow("analyzer:event", { kind: "stderr", line: chunk.toString() });
      });

      this.child.on("error", (error) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(error);
        }
        this.rejectPending(error);
      });

      this.child.on("close", (code) => {
        this.ready = false;
        clearTimeout(timeout);
        sendWindow("analyzer:event", { kind: "exit", code });
        if (!settled) {
          settled = true;
          reject(new Error(`Analyzer exited with code ${code}`));
        }
        this.rejectPending(new Error(`Analyzer exited with code ${code}`));
      });
    });
  }

  query(command: string) {
    if (!this.child || !this.ready || this.child.killed) {
      throw new Error("Analyzer is not running.");
    }
    const normalized = command.trim();
    if (!normalized) throw new Error("Query command is empty.");

    return new Promise((resolve, reject) => {
      const pending: PendingQuery = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending = this.pending.filter((item) => item !== pending);
          reject(new Error("Analyzer query timed out."));
        }, 60000)
      };
      this.pending.push(pending);
      this.child?.stdin.write(`${normalized}\n`, (error) => {
        if (!error) return;
        clearTimeout(pending.timer);
        this.pending = this.pending.filter((item) => item !== pending);
        reject(error);
      });
    });
  }

  stop() {
    if (this.child && !this.child.killed) {
      this.child.stdin.write("exit\n");
      setTimeout(() => {
        if (this.child && !this.child.killed) this.child.kill();
      }, 500);
    }
    this.stdout?.close();
    this.ready = false;
  }

  private rejectPending(error: Error) {
    for (const query of this.pending) {
      clearTimeout(query.timer);
      query.reject(error);
    }
    this.pending = [];
  }
}

function localDiagnosis(context: unknown, latestQuestion: string) {
  const data = context as Record<string, unknown> | null;
  if (!data || typeof data !== "object") {
    return "请先运行一次 k-mer 或序列查询。当前没有足够的诊断上下文。";
  }

  if (data.type === "sequence") {
    const missing = Number(data.missing || 0);
    const observed = Number(data.observed || 0);
    const minCoverage = Number(data.minCoverage || 0);
    const maxRatio = Number(data.maxAdjacentRatio || 0);
    const complete = data.complete === true;
    const coverageState = complete ? "路径完整" : `存在 ${missing} 个缺失 k-mer`;
    return [
      `基于当前序列路径：${coverageState}，已观测 k-mer 数为 ${observed}。`,
      `最低覆盖度 ${minCoverage}，最大相邻覆盖度比值 ${maxRatio.toFixed(3)}。`,
      missing > 0
        ? "优先检查 coverage 为 0 的断点位置；这些位置通常对应 dropout、合成/测序错误或目标片段不存在。"
        : "如果仍解码失败，下一步应看相邻覆盖度比值异常高的位置，它们可能提示局部扩增偏倚或路径分叉。",
      latestQuestion ? `针对你的问题：${latestQuestion}` : ""
    ].filter(Boolean).join("\n");
  }

  if (data.type === "kmer") {
    const coverage = Number(data.coverage || 0);
    const inDegree = Number(data.inDegree || 0);
    const outDegree = Number(data.outDegree || 0);
    return [
      `当前 k-mer 覆盖度为 ${coverage}，入度 ${inDegree}，出度 ${outDegree}。`,
      coverage === 0
        ? "该 k-mer 在测序表中未出现；如果它来自设计序列，说明此位置可能是 dropout 或存在测序错误。"
        : "覆盖度非零，说明该节点存在于测序 De Bruijn Graph 中。",
      inDegree + outDegree > 2
        ? "邻接分支较多，建议检查上下游是否存在重复序列、交叉链接或噪声 k-mer。"
        : "邻接关系较集中，路径歧义较低。"
    ].join("\n");
  }

  if (data.type === "summary") {
    return `当前 k=${data.k}，distinct k-mers=${data.distinctKmers}，累计覆盖=${data.totalKmerCoverage}。可继续查询目标 k-mer 或输入设计短片段做路径诊断。`;
  }

  return "当前结果类型暂不支持自动诊断，请提供 k-mer 或序列路径查询结果。";
}

function extractResponsesText(payload: any) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const chunks: string[] = [];
  for (const item of payload?.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

async function aiDiagnose(request: { messages?: Array<{ role: string; content: string }>; context?: unknown }) {
  const latestQuestion = request.messages?.filter((message) => message.role === "user").at(-1)?.content || "";
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { provider: "local", content: localDiagnosis(request.context, latestQuestion) };
  }

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: "You are a DNA information storage sequencing quality diagnostician. Explain DBGPS k-mer graph evidence concisely in Chinese. Focus on coverage, dropout, path completeness, adjacent coverage ratio, and graph branching."
        },
        {
          role: "user",
          content: `Analyzer context JSON:\n${JSON.stringify(request.context).slice(0, 10000)}\n\nUser question:\n${latestQuestion}`
        }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const text = await response.text();
    return { provider: "local", content: `${localDiagnosis(request.context, latestQuestion)}\n\nAI 服务返回错误：${text.slice(0, 400)}` };
  }

  const payload = await response.json();
  return { provider: "openai", content: extractResponsesText(payload) || localDiagnosis(request.context, latestQuestion) };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111418" : "#f5f7f8",
    title: "DBGPS Analyzer",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  ipcMain.handle("analyzer:selectFiles", async () => {
    const options: OpenDialogOptions = {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "FASTA/FASTQ", extensions: ["fa", "fasta", "fq", "fastq", "gz"] },
        { name: "All files", extensions: ["*"] }
      ]
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("analyzer:build", async () => {
    const log = await ensureAnalyzerBuilt(true);
    return { ok: true, log };
  });

  ipcMain.handle("analyzer:start", async (_event, config: AnalyzerConfig) => {
    session?.stop();
    session = new AnalyzerSession();
    return session.start(config);
  });

  ipcMain.handle("analyzer:query", async (_event, command: string) => {
    if (!session) throw new Error("Analyzer is not running.");
    return session.query(command);
  });

  ipcMain.handle("analyzer:stop", async () => {
    session?.stop();
    session = null;
    return { ok: true };
  });

  ipcMain.handle("ai:diagnose", async (_event, request) => aiDiagnose(request));

  createWindow();
});

app.on("window-all-closed", () => {
  session?.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
