#!/usr/bin/env python3
"""Summarize the FULL disagreement populations from a joined_comparison CSV.

Replaces the 'illustrative top-200' caveat in the manuscript with full-population
statistics, and writes a compact, committable disagreements.full.csv (all rows in
the consensus_only / dbgps_only classes — small enough to track, unlike the ~16 MB
full join).

Usage:
  python3 summarize_disagreements.py --joined /path/joined_comparison.full.csv \
      --out-csv ../summary/disagreements.full.csv
"""
from __future__ import annotations

import argparse
import csv
import statistics as st
from collections import Counter
from pathlib import Path


def num(x, cast=float):
    try:
        return cast(float(x))
    except (TypeError, ValueError):
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--joined", type=Path, required=True)
    ap.add_argument("--out-csv", type=Path, default=None)
    args = ap.parse_args()

    classes = Counter()
    dbgps_only, consensus_only = [], []
    rows_out = []
    fieldnames = None
    with args.joined.open() as fh:
        r = csv.DictReader(fh)
        fieldnames = r.fieldnames
        for row in r:
            cls = row.get("classification", "")
            classes[cls] += 1
            if cls in ("dbgps_only", "consensus_only"):
                rows_out.append(row)
                rec = {
                    "ed": num(row.get("consensus_edit_distance"), int),
                    "depth": num(row.get("consensus_read_count"), int),
                    "obs": num(row.get("dbgps_observed"), int),
                    "total": num(row.get("dbgps_total_kmers"), int),
                }
                (dbgps_only if cls == "dbgps_only" else consensus_only).append(rec)

    total = sum(classes.values())

    def med_range(vals):
        vals = [v for v in vals if v is not None]
        if not vals:
            return "n/a"
        return f"median {int(st.median(vals))}, range {min(vals)}-{max(vals)}"

    print(f"total strands: {total:,}")
    for k in ("agreement_recovered", "agreement_missing_or_broken", "consensus_only", "dbgps_only"):
        c = classes.get(k, 0)
        print(f"  {k:32s} {c:>8,}  ({100*c/total:.4f}%)")
    print()

    print(f"dbgps_only (n={len(dbgps_only)}): COMPLETE path but consensus not exact")
    ed = Counter(r["ed"] for r in dbgps_only if r["ed"] is not None)
    print("  edit_distance distribution:", dict(sorted(ed.items())))
    print("  read depth:", med_range([r["depth"] for r in dbgps_only]))
    obs_vals = [r["obs"] for r in dbgps_only if r["obs"] is not None]
    tot_vals = [r["total"] for r in dbgps_only if r["total"] is not None]
    complete_frac = sum(1 for r in dbgps_only if r["obs"] is not None and r["total"] is not None and r["obs"] == r["total"])
    print(f"  observed==total k-mers: {complete_frac}/{len(dbgps_only)}; observed range {min(obs_vals)}-{max(obs_vals)}; total k-mers seen: {sorted(set(tot_vals))[:5]}")
    print()

    print(f"consensus_only (n={len(consensus_only)}): consensus exact but path INCOMPLETE")
    ed2 = Counter(r["ed"] for r in consensus_only if r["ed"] is not None)
    print("  edit_distance distribution:", dict(sorted(ed2.items())))
    print("  read depth:", med_range([r["depth"] for r in consensus_only]))
    obs2 = [r["obs"] for r in consensus_only if r["obs"] is not None]
    if obs2:
        miss = [(r["total"] - r["obs"]) for r in consensus_only if r["obs"] is not None and r["total"] is not None]
        print(f"  observed k-mers range {min(obs2)}-{max(obs2)} of 134; missing per strand: median {int(st.median(miss))}, range {min(miss)}-{max(miss)}")

    if args.out_csv:
        args.out_csv.parent.mkdir(parents=True, exist_ok=True)
        with args.out_csv.open("w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=fieldnames)
            w.writeheader()
            for row in rows_out:
                w.writerow(row)
        print(f"\nwrote {len(rows_out)} disagreement rows -> {args.out_csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
