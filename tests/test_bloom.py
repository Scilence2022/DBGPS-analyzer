#!/usr/bin/env python3
"""Regression tests for the opt-in reference-target Bloom index.

Run after building dstoreqc, directly or through tests/run.sh. All input
and output fixtures are private temporary files; the full index is the oracle
for existing metrics, with independent canonical counts for reference scope.
"""

from collections import Counter
from itertools import islice, product
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parent.parent
DSTOREQC = Path(os.environ.get("DSTOREQC_TEST_BINARY", ROOT / "dstoreqc"))
SATURATION = (1 << 14) - 1
HEADER = "Ratio\tCoverage\tTotal\tPaths\tNoise\tExist\tLost\tSm\tKd\tKn"
REFERENCE_METADATA = {"indexScope", "referenceFile", "targetKmers", "bloom",
                      "globalNoiseAvailable", "unrestrictedQueriesAvailable"}
_failures = []
_passed = 0


def check(condition, message):
    global _passed
    if condition:
        _passed += 1
    else:
        _failures.append(message)
        print(f"  FAIL: {message}")


def run(args, stdin=None, command="analyze"):
    return subprocess.run(
        [str(DSTOREQC), command, *map(str, args)],
        input=stdin,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=ROOT,
        timeout=120,
    )


def fasta(path, records):
    path.write_text("".join(f">{name}\n{seq}\n" for name, seq in records), encoding="ascii")
    return path


def fastq(path, records):
    path.write_text(
        "".join(f"@{name}\n{seq}\n+\n{'I' * len(seq)}\n" for name, seq in records),
        encoding="ascii",
    )
    return path


def reverse_complement(seq):
    return seq.upper().translate(str.maketrans("ACGTN", "TGCAN"))[::-1]


def canonical_kmers(seq, k):
    seq = seq.upper()
    for i in range(len(seq) - k + 1):
        window = seq[i:i + k]
        if all(base in "ACGT" for base in window):
            yield min(window, reverse_complement(window))


def read_counts(records, k, read_length=200):
    counts = Counter()
    for _, seq in records:
        counts.update(canonical_kmers(seq[:max(k, read_length)], k))
    return Counter({key: min(value, SATURATION) for key, value in counts.items()})


def metric_rows(stdout):
    return [line.split("\t") for line in stdout.splitlines()
            if "\t" in line and not line.startswith("Ratio")]


def compare_metrics(full, bloom, label):
    baseline = metric_rows(full)
    actual = metric_rows(bloom)
    check(bool(baseline) and len(actual) == len(baseline), f"{label}: same nonempty metric grid")
    for i, (expected, got) in enumerate(zip(baseline, actual)):
        check(len(expected) == len(got) == 10, f"{label}: row {i} has ten columns")
        if len(expected) != 10 or len(got) != 10:
            continue
        check(all(got[j] == expected[j] for j in (0, 1, 2, 3, 5, 6, 7, 8)),
              f"{label}: row {i} preserves Ratio/Coverage/Total/Paths/Exist/Lost/Sm/Kd")
        check(got[4].lower() == "nan" and got[9].lower() == "nan",
              f"{label}: row {i} reports unavailable Noise and Kn as nan")


def kernel(args, commands, label):
    proc = run(args, stdin="\n".join([*commands, "exit", ""]), command="kernel")
    check(proc.returncode == 0, f"{label}: kernel exits 0 (stderr={proc.stderr!r})")
    events = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    check(bool(events) and events[0].get("type") == "ready", f"{label}: ready event")
    check(bool(events) and events[-1].get("type") == "bye", f"{label}: kernel remains usable through exit")
    return events


def events_of(events, kind):
    return [obj for obj in events if obj.get("type") == kind]


def core_fields(value):
    """Reference metadata can appear on envelopes and embedded summaries."""
    if isinstance(value, dict):
        return {key: core_fields(item) for key, item in value.items() if key not in REFERENCE_METADATA}
    if isinstance(value, list):
        return [core_fields(item) for item in value]
    return value


def compare_queries(full, bloom, label):
    for kind in ("sequence", "sequenceSummary", "batch"):
        expected = events_of(full, kind)
        actual = events_of(bloom, kind)
        check(bool(expected) and core_fields(actual) == core_fields(expected),
              f"{label}: {kind} matches the full index")


def check_metadata(event, reference, targets, counts, files, bits=16):
    label = event.get("type", "metadata")
    observed = {key for key in targets if counts[key] > 0}
    check(event.get("indexScope") == "reference", f"{label}: reference scope")
    check(event.get("referenceFile") == str(reference), f"{label}: reference filename")
    check(event.get("targetKmers") == len(targets), f"{label}: all distinct canonical target keys")
    check(event.get("distinctKmers") == len(observed), f"{label}: distinctKmers counts observed targets only")
    check(event.get("totalKmerCoverage") == sum(counts[key] for key in targets),
          f"{label}: coverage sums only observed reference keys")
    check(event.get("globalNoiseAvailable") is False, f"{label}: global noise unavailable")
    check(event.get("unrestrictedQueriesAvailable") is False, f"{label}: unrestricted queries unavailable")
    check(event.get("files") == list(map(str, files)), f"{label}: read files exclude the reference")
    bloom = event.get("bloom", {})
    check(bloom.get("backend") == "bfc-blocked", f"{label}: blocked BFC backend")
    check(bloom.get("bitsPerKey") == bits, f"{label}: bits per key {bits}")
    check(type(bloom.get("bytes")) is int and bloom["bytes"] > 0, f"{label}: positive allocated bytes")
    if type(bloom.get("bytes")) is int and bloom["bytes"] > 0:
        size = bloom["bytes"]
        check(size >= 64 and (size & (size - 1)) == 0 and size * 8 >= bits * len(targets),
              f"{label}: power-of-two allocation meets the requested minimum bits per key")
    check(bloom.get("hashes") == 6, f"{label}: six blocked Bloom hashes")


def mixed_fixture(tmp):
    a = "AACCGGTACGATTCGGAACCTTAC"
    repeated = "ACGTACGTACGTACGT"
    dropout = "GATACAGTCCTAGGCTAACG"
    broken = "TTGCCATGNNNCCGTAAGC"
    absent = "AAAAAAAA"
    noise = "CCCCCCCC"
    refs = [("forward", a), ("reverse_duplicate", reverse_complement(a)),
            ("repeated", repeated), ("dropout", dropout), ("N_break", broken),
            ("unobserved", absent), ("short", "ACG")]
    first = [("a", a), ("reverse_only", reverse_complement(a)),
             ("repeat", repeated), ("broken", broken.lower()),
             ("partial", dropout[:12]), ("off_reference", noise * 3),
             ("short", "ACG"), ("all_N", "N" * 12)]
    extra = [("a_again", a[:16].lower()), ("reverse_again", reverse_complement(a)),
             ("repeat_again", repeated), ("after_N", "CCGTAAGC"), ("noise", noise)]
    return {
        "reference": fasta(tmp / "reference.fa", refs),
        "reads": [fasta(tmp / "first.fa", first), fastq(tmp / "extra.fq", extra)],
        "combined": fasta(tmp / "combined.fa", first + extra),
        "refs": refs, "first": first, "extra": extra, "a": a,
        "repeated": repeated, "dropout": dropout, "absent": absent, "noise": noise,
        "targets": set(key for _, seq in refs for key in canonical_kmers(seq, 8)),
    }


def test_standalone_metrics_and_files():
    print("test_standalone_metrics_and_files")
    with tempfile.TemporaryDirectory(prefix="dstoreqc_bloom_") as directory:
        tmp = Path(directory)
        fixture = mixed_fixture(tmp)
        reference, reads = fixture["reference"], fixture["reads"]
        grid = ["-k", "8", "-C", "3", "-R", "3", "-I", "1", "-s", "1"]
        full_prefix, bloom_prefix = tmp / "full", tmp / "bloom"
        full = run([*grid, "-t", "1", "-o", full_prefix, reference, *reads])
        check(full.returncode == 0, f"full grid succeeds (stderr={full.stderr!r})")
        rows = metric_rows(full.stdout)
        check(len(rows) == 16, "baseline has four ratios by four coverage cutoffs")
        if rows:
            check(0 < int(rows[0][3]) < int(rows[0][2]) and int(rows[0][6]) > 0,
                  "fixture exercises recovered strands, dropout, and unobserved target keys")
            check(int(rows[0][4]) > 0, "baseline includes off-reference noise")

        # Default density, both supported endpoints, multiple threads, and split
        # FASTA/FASTQ versus a combined file must preserve the same target result.
        cases = [("default", [], "1", reads, ["-o", bloom_prefix]),
                 ("4-bit multicore", ["--bloom-bits", "4"], "4", reads, []),
                 ("64-bit combined", ["--bloom-bits", "64"], "3", [fixture["combined"]], [])]
        for label, density, threads, inputs, output in cases:
            bloom = run(["--bloom", *density, *grid, "-t", threads, *output, reference, *inputs])
            check(bloom.returncode == 0, f"{label}: standalone succeeds (stderr={bloom.stderr!r})")
            compare_metrics(full.stdout, bloom.stdout, label)
            if not output:
                continue
            # Preserve the legacy singular suffix actually written by the CLI.
            for extension in ("SmKdKn", "cov_details", "cov_ratios", "ratio_range"):
                full_path = Path(f"{full_prefix}.{extension}")
                bloom_path = Path(f"{bloom_prefix}.{extension}")
                check(full_path.is_file() and bloom_path.is_file(), f"{extension}: output files exist")
                if not full_path.is_file() or not bloom_path.is_file():
                    continue
                expected = full_path.read_text(encoding="ascii")
                actual = bloom_path.read_text(encoding="ascii")
                if extension == "SmKdKn":
                    check(actual.splitlines()[0] == HEADER, "metric file preserves its column header")
                    check(metric_rows(actual) == metric_rows(bloom.stdout), "metric file matches Bloom stdout")
                    compare_metrics(expected, actual, "metric file")
                else:
                    check(actual == expected, f"{extension}: byte-identical target output")


def test_default_mode_is_unchanged():
    print("test_default_mode_is_unchanged")
    with tempfile.TemporaryDirectory(prefix="dstoreqc_bloom_default_") as directory:
        tmp = Path(directory)
        reference = fasta(tmp / "reference.fa", [("observed", "ACGTACGT"), ("absent", "AAAA")])
        reads = fasta(tmp / "reads.fa", [("target", "ACGTACGT"), ("noise", "CCCC")])
        expected = "0.00\t0\t2\t1\t1\t3\t1\t0.500000\t0.250000\t0.333333"
        full = run(["-k", "4", reference, reads])
        check(full.returncode == 0 and metric_rows(full.stdout) == [expected.split("\t")],
              "default mode retains the full-index golden row including Noise and Kn")
        events = kernel(["-k", "4", reads], ["summary", "kmer CCCC 0 0", "index 0 4 0 0"], "default")
        check(not events_of(events, "error"), "default mode keeps unrestricted graph commands")
        check(len(events_of(events, "kmer")) == len(events_of(events, "index")) == 1,
              "default mode emits kmer and index results")
        for obj in events_of(events, "ready") + events_of(events, "summary"):
            check(obj.get("distinctKmers") == 4 and obj.get("totalKmerCoverage") == 6,
                  "default metadata still includes off-reference keys")
            check("bloom" not in obj and obj.get("indexScope") != "reference",
                  "default metadata does not claim a reference Bloom index")


def test_kernel_reference_scope_and_add_file():
    print("test_kernel_reference_scope_and_add_file")
    with tempfile.TemporaryDirectory(prefix="dstoreqc_bloom_kernel_") as directory:
        fixture = mixed_fixture(Path(directory))
        reference, reads = fixture["reference"], fixture["reads"]
        queries = [fixture["a"], reverse_complement(fixture["a"]), fixture["repeated"],
                   fixture["absent"], fixture["dropout"], "TTGCCATG", "CCGTAAGC"]
        commands = ["summary", *[f"sequence {seq}" for seq in queries],
                    f"sequenceSummary {fixture['a']}", f"batch 0 0 {reference}",
                    f"addFile {reads[1]}", "summary", *[f"sequence {seq}" for seq in queries],
                    f"sequenceSummary {fixture['a']}", f"batch 0 0 {reference}"]
        full = kernel(["-k", "8", "-t", "1", reads[0]], commands, "full incremental")
        bloom = kernel(["--bloom", "--bloom-reference", reference, "-k", "8", "-t", "4", reads[0]],
                       commands, "Bloom incremental")
        compare_queries(full, bloom, "incremental")
        check(not events_of(bloom, "error"), "in-reference sequence and batch commands accepted")
        metadata = events_of(bloom, "ready") + events_of(bloom, "summary")
        check(len(metadata) == 4, "ready, initial summary, addFile summary, and final summary emitted")
        counts_before = read_counts(fixture["first"], 8)
        counts_after = read_counts(fixture["first"] + fixture["extra"], 8)
        for i, event in enumerate(metadata):
            check_metadata(event, reference, fixture["targets"], counts_before if i < 2 else counts_after,
                           reads[:1] if i < 2 else reads)
        if metadata:
            check(0 < metadata[0].get("distinctKmers", 0) < len(fixture["targets"]),
                  "observed distinct count is positive and smaller than the indexed target set")
            check(all(obj.get("bloom") == metadata[0].get("bloom") for obj in metadata),
                  "addFile leaves the reference Bloom allocation and hash parameters unchanged")
        sequences = events_of(bloom, "sequence")
        if len(sequences) == 2 * len(queries):
            for offset, counts in ((0, counts_before), (len(queries), counts_after)):
                for seq, obj in zip(queries, sequences[offset:offset + len(queries)]):
                    expected = [counts[key] for key in canonical_kmers(seq, 8)]
                    check([entry["coverage"] for entry in obj.get("coverages", [])] == expected,
                          f"independent canonical coverage for {seq} at offset {offset}")
                absent = sequences[offset + 3]
                check(absent.get("missing") == 1 and absent.get("observed") == 0,
                      "an unobserved indexed key is a legitimate zero-coverage query")


def test_restricted_queries_and_safe_trimming():
    print("test_restricted_queries_and_safe_trimming")
    with tempfile.TemporaryDirectory(prefix="dstoreqc_bloom_queries_") as directory:
        tmp = Path(directory)
        fixture = mixed_fixture(tmp)
        reference, reads, a = fixture["reference"], fixture["reads"], fixture["a"]
        mixed = a[:8] + fixture["noise"] + a[-8:]
        across_n = "TTGCCATGCCGTAAGC"
        check(any(key not in fixture["targets"] for key in canonical_kmers(mixed, 8)),
              "mixed query has indexed endpoints but an out-of-reference interior")
        query_file = fasta(tmp / "queries.fa", [("inside", a), ("indexed_missing", fixture["absent"]),
                                                ("outside_interior", mixed), ("outside_observed", fixture["noise"])])
        trimmed_file = fasta(tmp / "trimmed.fa", [("safe", fixture["noise"] + a + fixture["noise"])])
        missing = tmp / "missing.fq"
        commands = [f"sequence {mixed}", f"sequenceSummary {reverse_complement(mixed)}",
                    f"sequence {across_n}", f"sequenceSummary {fixture['noise']}",
                    f"kmer {a[:8]} 0 0", "index 0 8 0 0", f"batch 0 0 {query_file}",
                    f"batch 8 8 {trimmed_file}", f"batch 4 4 {reference}",
                    f"sequence {a[:8]}", f"sequence {a[-8:]}",
                    f"addFile {missing}", "summary", f"addFile {reads[1]}",
                    f"sequence {fixture['noise']}", f"sequence {fixture['absent']}"]
        events = kernel(["--bloom", "--bloom-bits", "4", "--bloom-reference", reference,
                         "-k", "8", "-t", "3", *reads[:1]], commands, "restricted")
        check(len(events_of(events, "error")) == 8,
              "out-of-reference queries, graph commands, and missing addFile each produce an error")
        check([obj.get("type") for obj in events[1:7]] == ["error"] * 6,
              "sequence/sequenceSummary scan all windows and graph commands are unavailable")
        check(not events_of(events, "kmer") and not events_of(events, "index"),
              "no unrestricted graph results emitted in Bloom mode")
        for obj in events_of(events, "error"):
            check(bool(obj.get("message")), "restricted command error contains a diagnostic")
        batches = events_of(events, "batch")
        check(len(batches) == 3, "restricted and primer-trimmed batch results emitted")
        if len(batches) == 3:
            batch = batches[0]
            check(batch.get("ok") == 2 and batch.get("errors") == 2 and batch.get("total") == 4,
                  "batch reports in-reference rows and out-of-reference errors separately")
            rows = {row["name"]: row for row in batch["rows"]}
            for name in ("outside_interior", "outside_observed"):
                row = rows.get(name, {})
                check(row.get("status") == "error" and bool(row.get("message")) and "summary" not in row,
                      f"batch {name}: error row, not an invented zero-coverage summary")
            absent = rows.get("indexed_missing", {})
            check(absent.get("status") == "ok" and absent.get("summary", {}).get("missing") == 1,
                  "batch accepts indexed-but-unobserved keys")
            trimmed = batches[1].get("rows", [])
            check(len(trimmed) == 1 and trimmed[0].get("status") == "ok"
                  and trimmed[0].get("analyzedLength") == len(a),
                  "primer trimming safely removes out-of-reference flanks before membership checks")
            full = kernel(["-k", "8", *reads[:1]], [f"batch 4 4 {reference}"], "full trimmed")
            check(core_fields(batches[2]) == core_fields(events_of(full, "batch")[0]),
                  "trimmed reference batch matches baseline")
        summaries = events_of(events, "summary")
        if len(summaries) == 2:
            for i, event in enumerate(summaries):
                check_metadata(event, reference, fixture["targets"],
                               read_counts(fixture["first"] + (fixture["extra"] if i else []), 8),
                               reads if i else reads[:1], bits=4)
        else:
            check(False, "failed and successful addFile have the expected summaries")
        sequences = events_of(events, "sequence")
        check(len(sequences) == 3, "primer-end keys remain indexed and addFile does not admit noise")
        if len(sequences) == 3:
            check(all(obj.get("observed") == 1 for obj in sequences[:2]),
                  "construction indexes full reference sequences, including both primer ends")
            check(sequences[-1].get("missing") == 1, "kernel survives errors and still queries absent target")


def test_read_length_and_k_boundaries():
    print("test_read_length_and_k_boundaries")
    with tempfile.TemporaryDirectory(prefix="dstoreqc_bloom_lengths_") as directory:
        tmp = Path(directory)
        a = "AACCGGTACGATTCGGAACCTTACGATAGCTCGGATCAGTACCTGGAATCGTACCGTTAGCAGATTC"
        records = [("forward", a), ("reverse", reverse_complement(a)),
                   ("N_prefix", "NN" + a), ("short", "A")]
        reference = fasta(tmp / "reference.fa", [("target", a), ("homopolymer", "A" * 40)])
        reads = fastq(tmp / "reads.fq", records)
        for k, read_length, bits in ((1, 4, 4), (4, 9, 16), (31, 1, 64)):
            options = ["-k", k, "-L", read_length, "-t", "2", reads]
            commands = [f"sequence {a}", f"sequenceSummary {reverse_complement(a)}",
                        f"batch 0 0 {reference}", "summary"]
            full = kernel(options, commands, f"full k={k} L={read_length}")
            bloom = kernel(["--bloom", "--bloom-reference", reference, "--bloom-bits", bits, *options],
                           commands, f"Bloom k={k} L={read_length}")
            compare_queries(full, bloom, f"k={k} L={read_length}")
            counts = read_counts(records, k, read_length)
            targets = set(canonical_kmers(a, k)) | set(canonical_kmers("A" * 40, k))
            for obj in events_of(bloom, "ready") + events_of(bloom, "summary"):
                check_metadata(obj, reference, targets, counts, [reads], bits)
                check(obj.get("readLength") == read_length, f"k={k}: configured read length preserved")
            sequences = events_of(bloom, "sequence")
            if sequences:
                check([entry["coverage"] for entry in sequences[0].get("coverages", [])]
                      == [counts[key] for key in canonical_kmers(a, k)],
                      f"k={k}: truncated reads count canonical windows independently")


def test_low_density_does_not_expand_reference():
    print("test_low_density_does_not_expand_reference")
    with tempfile.TemporaryDirectory(prefix="dstoreqc_bloom_membership_") as directory:
        tmp = Path(directory)
        # At the minimum density, many distinct off-reference probes exercise
        # the exact membership guard behind the probabilistic prefilter.
        kmers = list(islice((seq for bases in product("ACGT", repeat=8)
                             for seq in ["".join(bases)] if seq <= reverse_complement(seq)), 384))
        targets, outsiders = kmers[:128], kmers[128:]
        reference = fasta(tmp / "reference.fa", [(f"target{i}", seq) for i, seq in enumerate(targets)])
        records = [(f"observed{i}", seq) for i, seq in enumerate(targets[:64])]
        records += [(f"noise{i}", reverse_complement(seq)) for i, seq in enumerate(outsiders)]
        reads = fastq(tmp / "reads.fq", records)
        commands = [*[f"sequence {seq}" for seq in outsiders[:128]],
                    *[f"sequenceSummary {seq}" for seq in outsiders[128:]],
                    f"sequence {targets[-1]}", "summary"]
        events = kernel(["--bloom", "--bloom-bits", "4", "--bloom-reference", reference,
                         "-k", "8", "-t", "4", reads], commands, "low-density membership")
        check(len(events_of(events, "error")) == len(outsiders),
              "every off-reference key is rejected even if a Bloom lookup could be positive")
        check(not events_of(events, "sequenceSummary") and len(events_of(events, "sequence")) == 1,
              "only an exact reference member receives a query result")
        counts = read_counts(records, 8)
        for obj in events_of(events, "ready") + events_of(events, "summary"):
            check_metadata(obj, reference, set(targets), counts, [reads], bits=4)
        sequences = events_of(events, "sequence")
        if sequences:
            check(sequences[0].get("missing") == 1 and sequences[0].get("maxCoverage") == 0,
                  "off-reference reads do not invent coverage for an unobserved reference member")


def test_saturation_and_incremental_counting():
    print("test_saturation_and_incremental_counting")
    with tempfile.TemporaryDirectory(prefix="dstoreqc_bloom_saturation_") as directory:
        tmp = Path(directory)
        reference = fasta(tmp / "reference.fa", [("hot", "A" * 12), ("cold", "C" * 12),
                                                ("absent", "ACGTACGT")])
        first = [(f"first{i}", "A" * 4096) for i in range(3)]
        extra = [(f"extra{i}", "T" * 4096) for i in range(2)] + [("cold", "C" * 20)]
        files = [fasta(tmp / "first.fa", first), fastq(tmp / "extra.fq", extra)]
        commands = ["sequence AAAAAAAA", f"addFile {files[1]}", "sequence TTTTTTTT", "summary"]
        options = ["-k", "8", "-L", "4096", "-t", "4"]
        full = kernel([*options, files[0]], commands, "full saturation")
        bloom = kernel(["--bloom", "--bloom-reference", reference, *options, files[0]],
                       commands, "Bloom saturation")
        for kind in ("sequence", "sequenceSummary"):
            check(core_fields(events_of(bloom, kind)) == core_fields(events_of(full, kind)),
                  f"saturation preserves {kind} results")
        sequences = events_of(bloom, "sequence")
        check(len(sequences) == 2, "coverage is queried before and after adding a file")
        if len(sequences) == 2:
            check(sequences[0].get("maxCoverage") == 3 * (4096 - 8 + 1) < SATURATION,
                  "initial count is below the existing saturation threshold")
            check(sequences[1].get("maxCoverage") == SATURATION,
                  "addFile saturates reverse-complement coverage at 16383")
        grid = [*options, "-c", SATURATION - 1, "-C", SATURATION + 1, reference, *files]
        baseline = run(grid)
        actual = run(["--bloom", *grid])
        check(baseline.returncode == actual.returncode == 0, "standalone saturation grid succeeds")
        compare_metrics(baseline.stdout, actual.stdout, "saturation cutoff grid")
        rows = metric_rows(actual.stdout)
        if len(rows) == 3:
            check([int(row[3]) for row in rows] == [1, 0, 0], "recovery uses strict cutoff across saturation")
            check([int(row[5]) for row in rows] == [1, 0, 0], "target existence uses strict cutoff across saturation")
        else:
            check(False, "three saturation cutoff rows emitted")


def test_invalid_options_and_references():
    print("test_invalid_options_and_references")
    with tempfile.TemporaryDirectory(prefix="dstoreqc_bloom_invalid_") as directory:
        tmp = Path(directory)
        reference = fasta(tmp / "reference.fa", [("target", "AACCGGTACGATTCGG")])
        reads = fasta(tmp / "reads.fa", [("read", "AACCGGTACGATTCGG")])
        missing = tmp / "missing.fa"
        empty = tmp / "empty.fa"
        empty.write_text("", encoding="ascii")
        text = tmp / "not_fasta.fa"
        text.write_text("this is not a sequence file\n", encoding="ascii")
        malformed = tmp / "truncated.fq"
        malformed.write_text("@broken\nAACCGGTACGATTCGG\n+\nII\n", encoding="ascii")
        cases = [("reference without Bloom", "kernel", ["--bloom-reference", reference, "-k", "8", reads]),
                 ("standalone reference without Bloom", "analyze", ["--bloom-reference", reference, "-k", "8", reference, reads]),
                 ("bits without Bloom", "analyze", ["--bloom-bits", "64", "-k", "8", reference, reads]),
                 ("interactive missing reference", "kernel", ["--bloom", "-k", "8", reads]),
                 ("standalone explicit reference", "analyze", ["--bloom", "--bloom-reference", reference, "-k", "8", reference, reads])]
        for bits in ("3", "65", "0", "-1", "4.5", "sixteen", "16junk", "2147483648", "999999999999999999999999"):
            cases.append((f"invalid Bloom bits {bits}", "analyze", ["--bloom", "--bloom-bits", bits, "-k", "8", reference, reads]))
        cases.extend([("missing bits argument", "analyze", ["-k", "8", reference, reads, "--bloom", "--bloom-bits"]),
                      ("missing reference argument", "kernel", ["-k", "8", reads, "--bloom", "--bloom-reference"])])
        bad_references = [("missing", missing), ("empty", empty), ("not FASTA", text),
                          ("malformed FASTQ", malformed),
                          ("no records", fasta(tmp / "empty_record.fa", [("empty", "")])),
                          ("no k-mers", fasta(tmp / "no_kmers.fa", [("short", "ACG"), ("ambiguous", "N" * 20)]))]
        for label, bad in bad_references:
            cases.append((f"standalone {label} reference", "analyze", ["--bloom", "-k", "8", bad, reads]))
            cases.append((f"interactive {label} reference", "kernel", ["--bloom", "--bloom-reference", bad, "-k", "8", reads]))
        cases.extend([("missing standalone reads", "analyze", ["--bloom", "-k", "8", reference, missing]),
                      ("missing interactive reads", "kernel", ["--bloom", "--bloom-reference", reference, "-k", "8", missing])])
        for label, command, args in cases:
            proc = run(args, stdin="exit\n", command=command)
            check(proc.returncode > 0, f"{label}: rejected without a signal (stderr={proc.stderr!r})")
            check(bool(proc.stderr.strip()), f"{label}: emits a diagnostic")
            check('"type":"ready"' not in proc.stdout and not metric_rows(proc.stdout),
                  f"{label}: no success event or misleading metric table")


def main():
    if not os.path.isfile(DSTOREQC):
        print(f"ERROR: {DSTOREQC} not built. Run `make` first (or use tests/run.sh).")
        return 2
    tests = [test_standalone_metrics_and_files, test_default_mode_is_unchanged,
             test_kernel_reference_scope_and_add_file, test_restricted_queries_and_safe_trimming,
             test_read_length_and_k_boundaries, test_low_density_does_not_expand_reference,
             test_saturation_and_incremental_counting,
             test_invalid_options_and_references]
    for test in tests:
        try:
            test()
        except (AssertionError, IndexError, KeyError, TypeError, ValueError, OSError, subprocess.TimeoutExpired) as exc:
            check(False, f"{test.__name__}: {type(exc).__name__}: {exc}")
    print()
    if _failures:
        print(f"FAILED: {len(_failures)} check(s) failed, {_passed} passed.")
        return 1
    print(f"OK: all {_passed} checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
