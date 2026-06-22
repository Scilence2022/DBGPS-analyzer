#!/usr/bin/env python3
"""End-to-end functional tests for the DBGPS command-line tools.

These tests drive the compiled binaries the same way a user (or the Electron
desktop app) would: by spawning a process, feeding it FASTA/FASTQ fixtures and
(for the interactive kernel) stdin commands, and asserting on the structured
output. They are deliberately implementation-agnostic so they keep passing
across the shared-core refactor and performance work.

Run via ``tests/run.sh`` (which builds the binaries first) or directly with
``python3 tests/test_cli.py`` once the tools are built at the repo root.
"""

import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "tests", "data")

ANALYZER = os.path.join(ROOT, "DBGPS-analyzer")
LINKS = os.path.join(ROOT, "DBGPS-links")
FILTER = os.path.join(ROOT, "DBGPS-seq-filter")

_failures = []
_passed = 0


def check(condition, message):
    global _passed
    if condition:
        _passed += 1
    else:
        _failures.append(message)
        print(f"  FAIL: {message}")


def data(name):
    return os.path.join(DATA, name)


def run(args, stdin=None):
    proc = subprocess.run(
        args,
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=ROOT,
        timeout=120,
    )
    return proc


def jsonl(stdout):
    """Parse the JSON objects emitted by the interactive kernel, one per line."""
    objects = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        objects.append(json.loads(line))
    return objects


def last_data_row(stdout):
    """Return the final tab-separated numeric row of an analyzer batch run."""
    rows = [ln for ln in stdout.splitlines() if "\t" in ln and not ln.startswith("Ratio")]
    return rows[-1].split("\t") if rows else None


# --------------------------------------------------------------------------- #
# Interactive kernel
# --------------------------------------------------------------------------- #
def test_interactive_kernel():
    print("test_interactive_kernel")
    commands = "summary\nsequence ACGTACGTACGT\nsequenceSummary ACGTACGTACGT\nkmer ACGT 1 1\nbogus\nexit\n"
    proc = run([ANALYZER, "-i", "-k", "4", data("reads.fa")], stdin=commands)
    check(proc.returncode == 0, f"kernel exit code 0 (got {proc.returncode})")
    objs = jsonl(proc.stdout)
    by_type = {}
    for obj in objs:
        by_type.setdefault(obj.get("type"), []).append(obj)

    check("ready" in by_type, "kernel emits a ready event")
    ready = by_type["ready"][0]
    check(ready["k"] == 4, f"ready reports k=4 (got {ready.get('k')})")
    check(ready["distinctKmers"] == 3, f"ready distinctKmers==3 (got {ready.get('distinctKmers')})")
    check(ready["totalKmerCoverage"] == 18, f"ready totalKmerCoverage==18 (got {ready.get('totalKmerCoverage')})")

    summary = by_type["summary"][0]
    check(summary["distinctKmers"] == 3, "summary distinctKmers==3")

    seq = by_type["sequence"][0]
    check(seq["kmerCount"] == 9, f"sequence kmerCount==9 (got {seq.get('kmerCount')})")
    check(seq["observed"] == 9 and seq["missing"] == 0, "sequence fully observed")
    check(seq["complete"] is True, "sequence complete==true")
    check(seq["minCoverage"] == 4 and seq["maxCoverage"] == 8, "sequence min/max coverage 4/8")

    seq_summary = by_type["sequenceSummary"][0]
    check(seq_summary["kmerCount"] == seq["kmerCount"], "sequenceSummary kmerCount matches sequence")
    check("coverages" not in seq_summary and "ratios" not in seq_summary, "sequenceSummary omits per-position arrays")

    kmer = by_type["kmer"][0]
    check(kmer["coverage"] == 6, f"kmer ACGT coverage==6 (got {kmer.get('coverage')})")
    check(kmer["inDegree"] == 1 and kmer["outDegree"] == 1, "kmer in/out degree 1/1")

    check("error" in by_type, "unknown command yields an error object")
    check(by_type["error"][0]["message"], "error object carries a message")


def test_interactive_validation():
    print("test_interactive_validation")
    # A k-mer query shorter than k must be rejected, not crash.
    proc = run([ANALYZER, "-i", "-k", "8", data("reads.fa")], stdin="kmer ACG\nexit\n")
    check(proc.returncode == 0, "kernel survives a too-short query")
    objs = jsonl(proc.stdout)
    errors = [o for o in objs if o.get("type") == "error"]
    check(len(errors) >= 1, "too-short k-mer query produces an error")

    # Invalid bases must be rejected.
    proc = run([ANALYZER, "-i", "-k", "4", data("reads.fa")], stdin="kmer ACXT\nexit\n")
    objs = jsonl(proc.stdout)
    errors = [o for o in objs if o.get("type") == "error"]
    check(len(errors) >= 1, "invalid base produces an error")


def test_interactive_batch_qc():
    print("test_interactive_batch_qc")
    commands = f"batch 0 0 {data('strands.fa')}\nexit\n"
    proc = run([ANALYZER, "-i", "-k", "4", data("reads.fa")], stdin=commands)
    check(proc.returncode == 0, f"batch kernel exit code 0 (got {proc.returncode})")
    objs = jsonl(proc.stdout)
    batches = [o for o in objs if o.get("type") == "batch"]
    check(len(batches) == 1, f"one batch result emitted (got {len(batches)})")
    batch = batches[0]
    check(batch["total"] == len(batch["rows"]) and batch["total"] > 0, "batch reports row count")
    first = batch["rows"][0]
    check(first["status"] == "ok", f"first batch row ok (got {first.get('status')})")
    summary = first["summary"]
    check(summary["type"] == "sequenceSummary", "batch row embeds compact sequence summary")
    check(summary["kmerCount"] == first["analyzedLength"] - 4 + 1, "batch kmer count matches row length")
    check(summary["observed"] > 0, "batch row has observed k-mers")
    check("coverages" not in summary and "ratios" not in summary, "batch summary omits per-position arrays")


# --------------------------------------------------------------------------- #
# Batch Sm/Kd/Kn metrics
# --------------------------------------------------------------------------- #
def test_batch_metrics():
    print("test_batch_metrics")
    proc = run([ANALYZER, "-k", "8", data("strands.fa"), data("ngs.fa")])
    check(proc.returncode == 0, f"batch exit code 0 (got {proc.returncode})")
    row = last_data_row(proc.stdout)
    check(row is not None, "batch emits a data row")
    if row:
        # Columns: Ratio Coverage Total Paths Noise Exist Lost Sm Kd Kn
        total, paths = int(row[2]), int(row[3])
        exist, lost = int(row[5]), int(row[6])
        sm, kd, kn = float(row[7]), float(row[8]), float(row[9])
        check(total == 2, f"Total strands==2 (got {total})")
        check(paths == 1, f"Recovered paths==1 (got {paths})")
        check(exist == 8 and lost == 4, f"exist/lost k-mers 8/4 (got {exist}/{lost})")
        check(abs(sm - 0.5) < 1e-6, f"Sm==0.5 (got {sm})")
        check(abs(kd - (4 / 12)) < 1e-6, f"Kd==0.333 (got {kd})")
        check(abs(kn - 0.875) < 1e-6, f"Kn==0.875 (got {kn})")


def test_batch_output_files(tmp_prefix="/tmp/dbgps_test_out"):
    print("test_batch_output_files")
    proc = run([ANALYZER, "-k", "8", "-o", tmp_prefix, data("strands.fa"), data("ngs.fa")])
    check(proc.returncode == 0, "batch with -o exits 0")
    for ext in ("SmKdKn", "cov_details", "cov_ratios", "ratio_range"):
        path = f"{tmp_prefix}.{ext}"
        check(os.path.exists(path), f"output file {ext} created")


def data_rows(stdout):
    """All tab-separated metric rows (excludes the header and >> Settings lines)."""
    return [ln for ln in stdout.splitlines() if "\t" in ln and not ln.startswith("Ratio")]


def test_grid_golden():
    """Pin the full ratio x coverage grid output. Guards the performance
    refactor (single-pass evaluation) against any change in the emitted
    Sm/Kd/Kn table, including the nan produced when exist k-mers == 0."""
    print("test_grid_golden")

    # 4 ratios (0..3) x 3 coverage cutoffs (0..2) over strands.fa/ngs.fa.
    cell = ["2\t1\t7\t8\t4\t0.500000\t0.333333\t0.875000",
            "2\t1\t2\t7\t5\t0.500000\t0.416667\t0.285714",
            "2\t0\t0\t2\t10\t0.000000\t0.833333\t0.000000"]
    expected = []
    for r in ("0.00", "1.00", "2.00", "3.00"):
        for ci, cov in enumerate(("0", "1", "2")):
            expected.append(f"{r}\t{cov}\t{cell[ci]}")
    proc = run([ANALYZER, "-k", "8", "-C", "2", "-R", "3.0", "-I", "1.0",
                data("strands.fa"), data("ngs.fa")])
    rows = data_rows(proc.stdout)
    check(rows == expected, f"strands grid matches golden\n   expected {expected}\n   got      {rows}")

    # skip_ratios + uniform data exercises the nan-Kn path (exist == 0).
    cell2 = ["1\t1\t0\t13\t0\t1.000000\t0.000000\t0.000000",
             "1\t0\t0\t0\t13\t0.000000\t1.000000\tnan"]
    expected2 = []
    for r in ("0.00", "1.00", "2.00"):
        for ci, cov in enumerate(("0", "1")):
            expected2.append(f"{r}\t{cov}\t{cell2[ci]}")
    proc2 = run([ANALYZER, "-k", "8", "-C", "1", "-R", "2.0", "-I", "1.0", "-s", "1",
                 data("uni_strand.fa"), data("uni_reads.fa")])
    rows2 = data_rows(proc2.stdout)
    check(rows2 == expected2, f"uniform skip-ratio grid matches golden\n   expected {expected2}\n   got      {rows2}")


def test_uniform_strand_ratio_filter():
    """Regression: a perfectly uniform, fully covered strand must count as
    recovered even when an adjacent-ratio cap (-r) is active. The old condition
    required strand_max_ratio > 1.0 and so wrongly dropped uniform strands."""
    print("test_uniform_strand_ratio_filter")
    base = run([ANALYZER, "-k", "8", data("uni_strand.fa"), data("uni_reads.fa")])
    capped = run([ANALYZER, "-k", "8", "-r", "2.0", data("uni_strand.fa"), data("uni_reads.fa")])
    base_row = last_data_row(base.stdout)
    capped_row = last_data_row(capped.stdout)
    check(base_row and int(base_row[3]) == 1, "uniform strand recovered without ratio cap")
    check(capped_row and int(capped_row[3]) == 1,
          "uniform strand still recovered with -r 2.0 (ratio-edge-case fix)")


# --------------------------------------------------------------------------- #
# DBGPS-links cross-link counting
# --------------------------------------------------------------------------- #
def test_links_count():
    """Regression for the hash-table iteration bug: the buggy loop skipped
    bucket 0 and read one past the end. Pin the corrected totals."""
    print("test_links_count")
    proc = run([LINKS, "-k", "8", data("links.fa")])
    check(proc.returncode == 0, f"links exit 0 (got {proc.returncode})")
    line = [ln for ln in proc.stdout.splitlines() if "cross links" in ln.lower()]
    check(len(line) == 1, "links prints a cross-link total")
    if line:
        count = int(line[0].split()[-1])
        check(count == 3, f"links k=8 cross links==3 (got {count})")

    proc31 = run([LINKS, "-k", "31", data("links.fa")])
    line31 = [ln for ln in proc31.stdout.splitlines() if "cross links" in ln.lower()]
    if line31:
        count31 = int(line31[0].split()[-1])
        check(count31 == 1, f"links k=31 cross links==1 (got {count31})")


# --------------------------------------------------------------------------- #
# DBGPS-seq-filter
# --------------------------------------------------------------------------- #
def test_seq_filter_default_passes():
    print("test_seq_filter_default_passes")
    proc = run([FILTER, "-k", "8", "-m", "0", "-p", "0", data("links.fa")])
    check(proc.returncode == 0, "seq-filter exit 0")
    names = [ln[1:] for ln in proc.stdout.splitlines() if ln.startswith(">")]
    check(names == ["s3"], f"default passes only unentangled s3 (got {names})")


def test_seq_filter_s_flag_lists_filtered():
    """Regression: -s used to be a no-op (output was hard-wired on). It now
    switches to emitting the names of filtered-out (entangled) strands."""
    print("test_seq_filter_s_flag_lists_filtered")
    proc = run([FILTER, "-k", "8", "-m", "0", "-p", "0", "-s", data("links.fa")])
    check(proc.returncode == 0, "seq-filter -s exit 0")
    lines = [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]
    check(lines == ["s1", "s2"], f"-s lists both globally entangled strands (got {lines})")
    check(not any(ln.startswith(">") for ln in lines), "-s does not emit FASTA records")


def test_seq_filter_threshold_is_monotonic():
    """The filter uses a global k-mer table, so raising -m cannot create more
    entangled records by changing which earlier strands were added to the table."""
    print("test_seq_filter_threshold_is_monotonic")
    counts = []
    for m in ("0", "1", "10"):
        proc = run([FILTER, "-k", "8", "-m", m, "-p", "0", "-s", data("links.fa")])
        check(proc.returncode == 0, f"seq-filter -m {m} exit 0")
        counts.append(len([ln for ln in proc.stdout.splitlines() if ln.strip()]))
    check(counts == sorted(counts, reverse=True), f"filtered counts are monotonic as m increases (got {counts})")


def test_seq_filter_skips_unscorable_after_primer_trim():
    """Regression: strands shorter than k after primer trimming must not be
    emitted as passed. The desktop view defaults to p=18, so short references
    previously looked like a successful all-pass filter run."""
    print("test_seq_filter_skips_unscorable_after_primer_trim")
    proc = run([FILTER, "-k", "8", "-m", "0", "-p", "18", data("links.fa")])
    check(proc.returncode == 0, "seq-filter skips unscorable strands without failing")
    check(proc.stdout.strip() == "", "unscorable primer-trimmed strands are not emitted as passed")
    check(proc.stderr.count("Skipping ") == 3, f"all short strands are reported as skipped (stderr={proc.stderr!r})")


def test_seq_filter_rejects_invalid_options():
    print("test_seq_filter_rejects_invalid_options")
    bad_k = run([FILTER, "-k", "32", data("links.fa")])
    bad_p = run([FILTER, "-p", "-1", data("links.fa")])
    bad_m = run([FILTER, "-m", "-1", data("links.fa")])
    check(bad_k.returncode != 0 and "-k must be between 1 and 31" in bad_k.stderr,
          "seq-filter rejects k values above the 2-bit encoder limit")
    check(bad_p.returncode != 0 and "-p must be non-negative" in bad_p.stderr,
          "seq-filter rejects negative primer length")
    check(bad_m.returncode != 0 and "-m must be non-negative" in bad_m.stderr,
          "seq-filter rejects negative max cross-links")


def main():
    for binary in (ANALYZER, LINKS, FILTER):
        if not os.path.exists(binary):
            print(f"ERROR: {binary} not built. Run `make` first (or use tests/run.sh).")
            return 2

    tests = [
        test_interactive_kernel,
        test_interactive_validation,
        test_interactive_batch_qc,
        test_batch_metrics,
        test_batch_output_files,
        test_grid_golden,
        test_uniform_strand_ratio_filter,
        test_links_count,
        test_seq_filter_default_passes,
        test_seq_filter_s_flag_lists_filtered,
        test_seq_filter_threshold_is_monotonic,
        test_seq_filter_skips_unscorable_after_primer_trim,
        test_seq_filter_rejects_invalid_options,
    ]
    for test in tests:
        test()

    print()
    if _failures:
        print(f"FAILED: {len(_failures)} check(s) failed, {_passed} passed.")
        return 1
    print(f"OK: all {_passed} checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
