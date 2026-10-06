type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
  timer: ReturnType<typeof setTimeout>;
};

export function validateReadOnlyCommand(command: unknown): asserts command is string {
  if (typeof command !== "string" || /[\r\n\0]/.test(command)) throw new Error("Analyzer query must be a single command line.");
  const verb = command.trim().split(/\s+/)[0];
  if (!["help", "summary", "kmer", "index", "sequence", "seq", "sequenceSummary", "seqSummary", "summarySequence"].includes(verb)) {
    throw new Error("Use a dedicated user control to load reads, select references, or stop the analyzer.");
  }
}

export class AnalyzerQueryQueue {
  private pending: Pending[] = [];

  constructor(private readonly onFatalTimeout: (error: Error) => void) {}

  enqueue(write: (callback: (error?: Error | null) => void) => void, timeoutMs: number, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.pending.length >= 1024) return Promise.reject(new Error("Analyzer request queue is full."));
    return new Promise<unknown>((resolve, reject) => {
      // A canceled request stays as a FIFO tombstone until its response arrives.
      // Removing it would assign its late response to the following request.
      const abort = () => reject(signal?.reason || new Error("Analyzer query canceled."));
      const item: Pending = {
        resolve, reject, cleanup: () => signal?.removeEventListener("abort", abort),
        timer: setTimeout(() => {
          const error = new Error("Analyzer query timed out; session stopped to prevent stale-response attribution.");
          this.failAll(error);
          this.onFatalTimeout(error);
        }, timeoutMs)
      };
      this.pending.push(item);
      signal?.addEventListener("abort", abort, { once: true });
      const failed = (error?: Error | null) => {
        if (!error) return;
        this.failAll(error);
        this.onFatalTimeout(error);
      };
      try { write(failed); } catch (error) { failed(error instanceof Error ? error : new Error("Analyzer write failed.")); }
    });
  }

  complete(payload: unknown) {
    const item = this.pending.shift();
    if (!item) return false;
    clearTimeout(item.timer);
    item.cleanup();
    item.resolve(payload);
    return true;
  }

  failAll(error: Error) {
    for (const item of this.pending) {
      clearTimeout(item.timer);
      item.cleanup();
      item.reject(error);
    }
    this.pending = [];
  }
}
