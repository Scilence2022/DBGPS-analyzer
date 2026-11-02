// Presentation rules for the Decoder readiness panel. Kept apart from the renderer
// so they can be tested without a DOM.

export type FailureRow = { failure: string; label: string; count: number; share: number };

const FAILURE_LABELS: Record<string, string> = {
  seed_missing: "Seed k-mer never observed",
  missing: "Designed k-mer never observed",
  below_cutoff: "Coverage at or below the cutoff",
  ratio_drop: "Coverage fell past the ratio window",
  ratio_rise: "Coverage rose past the ratio window",
  extra_step_none: "Extra step found no successor",
  too_short: "Strand too short for the walk",
  invalid_base: "Non-ACGT base in the walk"
};

export function failureLabel(failure: string) {
  return failure === "ok" ? "Decodable" : FAILURE_LABELS[failure] || failure;
}

// Largest reason first, so the row a user should read next is at the top.
export function failureRows(failures: Record<string, number>, total: number): FailureRow[] {
  return Object.entries(failures)
    .filter(([, count]) => count > 0)
    .map(([failure, count]) => ({ failure, label: failureLabel(failure), count, share: total > 0 ? count / total : 0 }))
    .sort((a, b) => b.count - a.count);
}

// Accepts "50, 120" or "50 120"; anything else is an input error, never a silent drop.
export function parseWaivedKmers(text: string): number[] {
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  if (tokens.length > 16) throw new Error("List at most 16 k-mers to waive.");
  return tokens.map((token) => {
    if (!/^\d+$/.test(token)) throw new Error(`"${token}" is not a k-mer index.`);
    return Number(token);
  });
}

export function hotspotKmers(hotspots: Array<{ kmer: number }>) {
  return hotspots.map((spot) => spot.kmer).sort((a, b) => a - b);
}

export function hotspotShare(hotspots: Array<{ count: number }>, ratioFailures: number) {
  if (ratioFailures <= 0) return 0;
  return hotspots.reduce((sum, spot) => sum + spot.count, 0) / ratioFailures;
}

// A hotspot among a handful of residual failures is chance, not a coverage step, so
// only suggest a waiver when it explains most ratio failures and those matter.
export function shouldOfferWaiver(hotspots: Array<{ count: number }>, ratioFailures: number, lost: number) {
  return hotspots.length > 0 && hotspotShare(hotspots, ratioFailures) >= 0.5 && ratioFailures >= lost * 0.01;
}
