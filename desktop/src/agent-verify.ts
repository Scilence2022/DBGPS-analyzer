import type { AgentToolTrace, AgentVerification, AgentVerifiedValue } from "./agent-types";

// Checks every number an answer states against the evidence the run actually saw:
// tool results that succeeded, the snapshot, the question and the system prompt.
// A value is supported when it appears there at the precision written, derived when
// it is the sum, difference or share of two values the answer itself states and that
// are supported (or of a reported total), and unsupported otherwise. Operands are
// limited to what the answer shows, so a derivation cannot be assembled by chance
// from the many numbers in the evidence.
// It is a deterministic check of provenance, not of reasoning: a supported number can
// still be used wrongly, but an unsupported one was not read from any evidence.

const MAX_CLAIMS = 200;
const MAX_EVIDENCE = 20000;
// Arrays longer than this hold bulk measurements, not reported quantities.
const BULK = 12;
// Line-start list markers and values of at most this size are not checked.
const TRIVIAL = 2;

type Claim = { text: string; value: number; decimals: number; percent: boolean; context: string };

const NUMBER = /(?<![\w.,])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\w]|\.\d|,\d{3})%?/g;

function parseNumber(text: string) {
  const percent = text.endsWith("%");
  const body = (percent ? text.slice(0, -1) : text).replace(/,/g, "");
  const point = body.indexOf(".");
  return { value: Number(body), decimals: point < 0 ? 0 : body.length - point - 1, percent };
}

export function extractClaims(answer: string): Claim[] {
  const claims: Claim[] = [];
  for (const line of answer.split("\n")) {
    const marker = line.match(/^\s*(?:[-*+]\s+)?(\d+)[.)]\s/);
    for (const match of line.matchAll(NUMBER)) {
      if (marker && match.index === line.indexOf(marker[1])) continue;
      const parsed = parseNumber(match[0]);
      if (!Number.isFinite(parsed.value) || Math.abs(parsed.value) <= TRIVIAL) continue;
      const at = match.index ?? 0;
      claims.push({ text: match[0], ...parsed, context: line.slice(Math.max(0, at - 40), at + match[0].length + 40).trim() });
      if (claims.length >= MAX_CLAIMS) return claims;
    }
  }
  return claims;
}

// Numbers held anywhere in a value: JSON numbers, and numbers written in strings.
// Totals are the denominators a share may be taken of; a total inside a long array
// (a page of rows) is a measurement, not a reported total.
export function evidenceNumbers(sources: unknown[]) {
  const all = new Set<number>();
  const totals = new Set<number>();
  const add = (value: number) => {
    if (Number.isFinite(value) && all.size < MAX_EVIDENCE) all.add(value);
  };
  const visit = (value: unknown, depth: number, bulk: boolean, key: string) => {
    if (all.size >= MAX_EVIDENCE || depth > 12) return;
    if (typeof value === "number") {
      add(value);
      if (!bulk && /^(total|matchedTotal|strands|reads|pathKmers)$/.test(key) && value > 0) totals.add(value);
      return;
    }
    if (typeof value === "string") {
      for (const match of value.matchAll(NUMBER)) {
        const parsed = parseNumber(match[0]);
        add(parsed.percent ? parsed.value / 100 : parsed.value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, bulk || value.length > BULK, key);
      return;
    }
    if (value && typeof value === "object") for (const [name, item] of Object.entries(value)) visit(item, depth + 1, bulk, name);
  };
  for (const source of sources) visit(source, 0, false, "");
  return { all: [...all], totals: [...totals] };
}

// Whether evidence value e, written at the claim's precision, reads as the claim.
function reads(claim: Claim, e: number) {
  const scale = 10 ** claim.decimals;
  const as = (x: number) => Math.abs(Math.round(x * scale) / scale - claim.value) < 0.5 / scale + 1e-9;
  if (claim.percent) return as(e * 100) || as(e);
  return Math.abs(e - claim.value) < 1e-9 || (claim.decimals < 6 && !Number.isInteger(e) && as(e));
}

function derivation(claim: Claim, operands: number[]): string | null {
  const values = [...new Set(operands)].filter((v) => v !== 0);
  if (claim.percent || !Number.isInteger(claim.value)) {
    for (const a of values) for (const b of values) {
      if (a !== b && Math.abs(a) <= Math.abs(b) && reads(claim, a / b)) return claim.percent ? `${a} / ${b} × 100` : `${a} / ${b}`;
    }
    return null;
  }
  const counts = values.filter((v) => Number.isInteger(v));
  const set = new Set(counts);
  for (const a of counts) {
    if (a !== claim.value && set.has(a - claim.value)) return `${a} − ${a - claim.value}`;
    if (a !== claim.value && set.has(claim.value - a)) return `${a} + ${claim.value - a}`;
  }
  return null;
}

export function verifyAgentAnswer(options: { answer: string; question: string; system: string; snapshot: unknown; trace: AgentToolTrace[] }): AgentVerification {
  const results = options.trace.filter((item) => item.status === "ok").map((item) => (item.result as { data?: unknown } | undefined)?.data);
  const evidence = evidenceNumbers([options.question, options.system, options.snapshot, ...results]);
  const claims = extractClaims(options.answer);
  const direct = claims.map((claim) => evidence.all.some((e) => reads(claim, e)));
  // Operands: supported values the answer states (as written, and as fractions for
  // percents) and the snapshot's and tools' totals.
  const operands = [...evidence.totals, ...claims.filter((_, i) => direct[i]).map((claim) => (claim.percent ? claim.value / 100 : claim.value))];
  const checked: AgentVerifiedValue[] = claims.map((claim, i) => {
    if (direct[i]) return { text: claim.text, status: "supported", context: claim.context };
    const how = derivation(claim, operands);
    return how ? { text: claim.text, status: "derived", from: how, context: claim.context } : { text: claim.text, status: "unsupported", context: claim.context };
  });
  const tally = (status: AgentVerifiedValue["status"]) => checked.filter((item) => item.status === status).length;
  return {
    checked: checked.length, supported: tally("supported"), derived: tally("derived"), unsupported: tally("unsupported"),
    values: checked, evidenceValues: evidence.all.length
  };
}

export function revisionNote(verification: AgentVerification) {
  const missing = verification.values.filter((item) => item.status === "unsupported").slice(0, 20);
  return [
    `Verification of your draft answer: ${missing.length} stated value${missing.length === 1 ? " was" : "s were"} not found in any retrieved evidence, nor derived from it:`,
    ...missing.map((item) => `- ${item.text} (in: "${item.context}")`),
    "Retrieve evidence for each of them with the tools, or correct or remove them, then give the complete corrected answer, including any required final line."
  ].join("\n");
}
