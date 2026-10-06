import { randomUUID } from "node:crypto";
import { AGENT_LIMITS, compactAgentContext, type AgentBackend } from "./agent";
import type { AgentSnapshot } from "./agent-types";

export const EVIDENCE_LIMITS = Object.freeze({ batchRows: 250000, cachedSequenceBases: 40000000 });

export type EvidenceRow = {
  index: number;
  name: string;
  rawLength: number;
  analyzedLength: number;
  status: "ok" | "skipped" | "error";
  message?: string;
  summary?: {
    type: string; length: number; k: number; kmerCount: number; observed: number; missing: number;
    complete: boolean; minCoverage: number; maxCoverage: number; meanCoverage: number; maxAdjacentRatio: number;
  };
};

type Dataset = { id: string; k: number; threads: number; readLength: number };
type Batch = {
  id: string;
  datasetVersion: string;
  primerFront: number;
  primerBack: number;
  rows: EvidenceRow[];
  sequences: Map<number, string>;
  aggregates: { total: number; complete: number; incomplete: number; skipped: number; errors: number };
};

export type EvidenceKernel = { query(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> };

export class AgentEvidenceStore {
  private dataset: Dataset | null = null;
  private batch: Batch | null = null;
  private activeSequence: string | null = null;

  invalidate() {
    this.dataset = null;
    this.batch = null;
    this.activeSequence = null;
  }

  activate(config: { k: number; threads: number; readLength: number }) {
    this.invalidate();
    this.dataset = { id: randomUUID(), ...config };
    return this.dataset.id;
  }

  getDatasetVersion() { return this.dataset?.id || null; }

  clearBatch() { this.batch = null; }

  selectSequence(sequence: string) {
    this.activeSequence = /^[ACGT]+$/.test(sequence) && sequence.length <= AGENT_LIMITS.sequenceBases ? sequence : null;
  }

  cacheBatch(datasetVersion: string, primerFront: number, primerBack: number, rows: EvidenceRow[], sequences: Map<number, string>) {
    if (!this.dataset || this.dataset.id !== datasetVersion) throw new Error("Dataset changed during Batch QC; result not cached.");
    this.batch = null;
    if (rows.length > EVIDENCE_LIMITS.batchRows) return false;
    let bases = 0;
    const eligible = new Map<number, string>();
    for (const [index, sequence] of sequences) {
      if (sequence.length > AGENT_LIMITS.sequenceBases || bases + sequence.length > EVIDENCE_LIMITS.cachedSequenceBases) continue;
      eligible.set(index, sequence);
      bases += sequence.length;
    }
    const saved = rows.map((row) => ({ ...row, summary: row.summary ? { ...row.summary } : undefined }));
    const complete = saved.filter((row) => row.status === "ok" && row.summary?.complete).length;
    const incomplete = saved.filter((row) => row.status === "ok" && row.summary && !row.summary.complete).length;
    const skipped = saved.filter((row) => row.status === "skipped").length;
    this.batch = {
      id: randomUUID(), datasetVersion, primerFront, primerBack, rows: saved, sequences: eligible,
      aggregates: { total: saved.length, complete, incomplete, skipped, errors: saved.length - complete - incomplete - skipped }
    };
    return true;
  }

  open(context: unknown, kernel: EvidenceKernel | null): { snapshot: AgentSnapshot; backend: AgentBackend } {
    const dataset = this.dataset;
    const batch = this.batch;
    const sequence = this.activeSequence;
    const input = context && typeof context === "object" ? context as Record<string, unknown> : {};
    const active = input.activeView && typeof input.activeView === "object" ? input.activeView as Record<string, unknown> : null;
    const stale = typeof active?.datasetVersion === "string" && active.datasetVersion !== dataset?.id;
    const accepted = stale ? { ...input, activeView: { unavailable: true, reason: "Active-view result belongs to an older index version." } } : context;
    const snapshot: AgentSnapshot = {
      id: randomUUID(), datasetVersion: dataset?.id || null, batchVersion: batch?.id || null,
      createdAt: new Date().toISOString(), context: compactAgentContext(accepted)
    };
    const assertCurrent = () => {
      if (this.dataset?.id !== dataset?.id || this.batch?.id !== batch?.id) throw new Error("Evidence snapshot is stale; ask again against the current dataset.");
    };
    const query = async (command: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      assertCurrent();
      if (!dataset || !kernel) throw new Error("No loaded read index is available. Start it manually before requesting analyzer tools.");
      const result = await kernel.query(command, 60000, signal);
      signal.throwIfAborted();
      assertCurrent();
      if (!result || typeof result !== "object" || (result as { type?: string }).type === "error") throw new Error("Analyzer query failed; no measurement adopted.");
      return result as Record<string, unknown>;
    };
    const backend: AgentBackend = {
      assertCurrent,
      getK: () => dataset?.k || 0,
      getSummary: async (signal) => {
        const result = await query("summary", signal);
        if (result.type !== "summary") throw new Error("Unexpected analyzer summary response.");
        return {
          type: result.type, k: result.k, distinctKmers: result.distinctKmers,
          totalKmerCoverage: result.totalKmerCoverage,
          threads: dataset?.threads, readLength: dataset?.readLength,
          countSaturation: 16383, exactness: "exact canonical membership and saturated counts",
          batch: batch ? { id: batch.id, primerFront: batch.primerFront, primerBack: batch.primerBack, ...batch.aggregates, cachedProfiles: batch.sequences.size } : null,
          selectedSequenceAvailable: Boolean(sequence)
        };
      },
      getSequence: async (recordIndex, signal) => {
        const row = recordIndex == null ? null : batch?.rows.find((item) => item.index === recordIndex);
        const selected = recordIndex == null ? sequence : batch?.sequences.get(recordIndex);
        if (recordIndex != null && (!row || row.status !== "ok" || !row.summary)) throw new Error("Batch record is unavailable, invalid, or skipped in this snapshot.");
        if (!selected) throw new Error("Sequence is not in the bounded main-process snapshot cache. Select it manually in Interactive and ask again.");
        const result = await query(`sequence ${selected}`, signal);
        return {
          reference: row ? { index: row.index, name: row.name.slice(0, 200), batchVersion: batch?.id, primerFront: batch?.primerFront, primerBack: batch?.primerBack } : { source: "user-selected Interactive sequence", primerScope: "as queried by user" },
          result
        };
      },
      queryKmer: async (kmer, depth, signal) => {
        const result = await query(`kmer ${kmer} ${depth} ${depth}`, signal);
        if (result.type !== "kmer") throw new Error("Unexpected k-mer response.");
        return { ...result, graphSemantics: "membership-derived overlaps, not read-supported transitions" };
      },
      getBatchRows: (status, offset, limit) => {
        assertCurrent();
        if (!batch) throw new Error("No completed Batch QC snapshot is available in the bounded cache.");
        const matching = batch.rows.filter((row) => status === "all" || (status === "incomplete" ? row.status === "ok" && row.summary && !row.summary.complete : row.status === status));
        return {
          batchVersion: batch.id, k: dataset?.k, primerFront: batch.primerFront, primerBack: batch.primerBack,
          aggregates: batch.aggregates, selection: { status, order: "processing order", offset, limit, matchedTotal: matching.length, truncated: offset > 0 || offset + limit < matching.length },
          rows: matching.slice(offset, offset + limit).map((row) => ({ ...row, name: row.name.slice(0, 200), message: row.message?.slice(0, 200), profileCached: batch.sequences.has(row.index) }))
        };
      }
    };
    return { snapshot, backend };
  }
}
