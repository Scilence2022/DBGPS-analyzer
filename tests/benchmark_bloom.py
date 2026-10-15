#!/usr/bin/env python3
"""Compare full and Bloom reference kernels on identical local inputs.

Example: python3 tests/benchmark_bloom.py --reference reference.tab \
    --reads reads.fq.gz --output tmp/bloom-benchmark
Requires /usr/bin/time; peak RSS covers the C kernel, not the desktop process.
"""
import argparse
import csv
import gzip
import hashlib
from itertools import chain
import json
from pathlib import Path
import re
import subprocess
import sys
import time


SCOPE_KEYS = {
    "indexScope", "referenceFile", "targetKmers", "bloom",
    "globalNoiseAvailable", "unrestrictedQueriesAvailable",
}


def without_scope(value):
    if isinstance(value, dict):
        return {key: without_scope(item) for key, item in value.items() if key not in SCOPE_KEYS}
    if isinstance(value, list):
        return [without_scope(item) for item in value]
    return value


def normalize_reference(source, destination):
    opener = gzip.open if source.suffix == ".gz" else open
    with opener(source, "rt") as handle, destination.open("w") as out:
        first = next((line for line in handle if line.strip()), "")
        if first.startswith((">", "@")):
            out.write(first)
            for line in handle:
                out.write(line)
            return
        records = 0
        for fields in csv.reader(chain((first,), handle), delimiter="\t"):
            if not fields:
                continue
            dna = next((field.strip() for field in reversed(fields[1:])
                        if re.fullmatch("[ACGTNacgtn]+", field.strip())), None)
            if dna is None:
                if records == 0:
                    continue
                raise ValueError("Malformed reference row")
            name = re.sub(r"\s+", "_", fields[0].strip()) or f"seq{records + 1}"
            out.write(f">{name}\n{dna.upper()}\n")
            records += 1
        if records == 0:
            raise ValueError("No reference sequences")


def run_mode(args, reference, mode):
    command = [str(args.binary.resolve()), "-i", "-k", str(args.k), "-t", str(args.threads), "-L", str(args.read_length)]
    if mode == "bloom":
        command += ["--bloom", "--bloom-reference", str(reference), "--bloom-bits", str(args.bloom_bits)]
    command += [str(file.resolve()) for file in args.reads]
    timed = ["/usr/bin/time", "-l" if sys.platform == "darwin" else "-v", *command]
    out_path = args.output / f"{mode}.jsonl"
    err_path = args.output / f"{mode}.log"
    started = time.monotonic()
    with out_path.open("w") as out, err_path.open("w") as err:
        result = subprocess.run(timed, input=f"batch {args.front} {args.back} {reference}\nexit\n", text=True, stdout=out, stderr=err, check=False)
    elapsed = time.monotonic() - started
    if result.returncode:
        raise RuntimeError(f"{mode} exited {result.returncode}: see {err_path}")
    log = err_path.read_text()
    if sys.platform == "darwin":
        match = re.search(r"(\d+)\s+maximum resident set size", log)
        peak = int(match[1]) if match else None
    else:
        match = re.search(r"Maximum resident set size \(kbytes\):\s*(\d+)", log)
        peak = int(match[1]) * 1024 if match else None
    ready = None
    rows = None
    with out_path.open() as handle:
        for line in handle:
            event = json.loads(line)
            if event.get("type") == "ready":
                ready = event
            elif event.get("type") == "batch":
                rows = without_scope(event["rows"])
    if ready is None or rows is None:
        raise RuntimeError(f"Missing results in {out_path}")
    digest = hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    complete = sum(row.get("summary", {}).get("complete", False) for row in rows)
    return {
        "command": command, "wallSeconds": elapsed, "peakRssBytes": peak,
        "ready": ready, "batchRows": len(rows), "pathComplete": complete,
        "rowSha256WithoutScope": digest,
        "errorRows": sum(row.get("status") == "error" for row in rows),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--reads", type=Path, nargs="+", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--binary", type=Path, default=Path(__file__).resolve().parent.parent / "DBGPS-analyzer")
    parser.add_argument("--k", type=int, default=31)
    parser.add_argument("--threads", type=int, default=16)
    parser.add_argument("--read-length", type=int, default=200)
    parser.add_argument("--bloom-bits", type=int, default=16)
    parser.add_argument("--front", type=int, default=18)
    parser.add_argument("--back", type=int, default=18)
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    reference = args.output / "reference.fa"
    if args.reference.resolve() == reference:
        raise ValueError("Input reference must differ from the generated benchmark reference")
    normalize_reference(args.reference, reference)
    results = {}
    for mode in ("full", "bloom"):
        print(f"Running {mode} kernel...", flush=True)
        results[mode] = run_mode(args, reference, mode)
        print(json.dumps(results[mode], indent=2), flush=True)
    results["rowsEquivalent"] = results["full"]["rowSha256WithoutScope"] == results["bloom"]["rowSha256WithoutScope"]
    if all(results[mode]["peakRssBytes"] for mode in ("full", "bloom")):
        results["peakRssReductionFactor"] = results["full"]["peakRssBytes"] / results["bloom"]["peakRssBytes"]
    (args.output / "comparison.json").write_text(json.dumps(results, indent=2) + "\n")
    if not results["rowsEquivalent"] or results["bloom"]["errorRows"]:
        raise RuntimeError("Full and Bloom Batch QC results differ or include error rows")
    print("All Batch QC rows match; comparison.json written.")


if __name__ == "__main__":
    main()
