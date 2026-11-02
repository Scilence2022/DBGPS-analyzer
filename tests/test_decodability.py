#!/usr/bin/env python3
"""End-to-end tests for `dstoreqc decodability` and the kernel command of that name.

Each case builds a small strand and reads whose k-mer coverage is known exactly,
so every expected verdict follows from the decoder's admission rule.
"""
import csv
import json
from pathlib import Path
import random
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "dstoreqc"

K = 7
PRIMER, INDEX, PATH_LENGTH = 5, 4, 40
LAYOUT = ("--primer", PRIMER, "--index-length", INDEX, "--path-length", PATH_LENGTH)
NEEDED = PRIMER + INDEX + PATH_LENGTH   # 49 nt; the seed is k-mer 2


def run(*args, stdin=None):
    return subprocess.run([str(CLI), *map(str, args)], input=stdin, capture_output=True,
                          text=True, cwd=ROOT, timeout=120)


def unique_sequence(length, seed):
    """Random DNA with no repeated canonical k-mer, so coverage is exactly controlled."""
    rng = random.Random(seed)
    complement = str.maketrans("ACGT", "TGCA")
    seq, seen = "", set()
    while len(seq) < length:
        base = rng.choice("ACGT")
        candidate = seq + base
        if len(candidate) >= K:
            kmer = candidate[-K:]
            canonical = min(kmer, kmer.translate(complement)[::-1])
            if canonical in seen or kmer == kmer.translate(complement)[::-1]:
                continue
            seen.add(canonical)
        seq = candidate
    return seq


def fasta(path, records):
    Path(path).write_text("".join(f">{name}\n{seq}\n" for name, seq in records))
    return path


class Decodability(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def verdict(self, strand, reads, *options):
        reference = fasta(self.dir / "ref.fa", [("s1", strand)])
        read_file = fasta(self.dir / "reads.fa", [(f"r{i}", r) for i, r in enumerate(reads)])
        result = run("decodability", "-k", K, "-t", 2, "--json", *LAYOUT, *options, reference, read_file)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def failure(self, report, config=0):
        failures = report["configs"][config]["failures"]
        return [name for name, count in failures.items() if count]

    def test_evenly_covered_strand_is_decodable(self):
        strand = unique_sequence(60, 1)
        report = self.verdict(strand, [strand] * 5)
        self.assertEqual(report["seedKmer"], 2)
        self.assertEqual(report["pathKmers"], 41)
        self.assertEqual(report["configs"][0]["decodable"], 1)

    def test_single_read_fails_the_default_cutoff(self):
        strand = unique_sequence(60, 2)
        report = self.verdict(strand, [strand])
        self.assertEqual(self.failure(report), ["below_cutoff"])
        self.assertEqual(self.verdict(strand, [strand], "-c", 0)["configs"][0]["decodable"], 1)

    def test_extra_step_without_successor(self):
        strand = unique_sequence(NEEDED, 3)
        self.assertEqual(self.failure(self.verdict(strand, [strand] * 5)), ["extra_step_none"])
        self.assertEqual(self.verdict(strand, [strand] * 5, "--no-extra-step")["configs"][0]["decodable"], 1)

    def test_extra_step_with_two_successors_repeats_one_candidate(self):
        strand = unique_sequence(60, 4)
        last = strand[NEEDED]
        other = next(b for b in "ACGT" if b != last)
        variant = strand[:NEEDED] + other
        report = self.verdict(strand, [strand] * 5 + [variant] * 5)
        self.assertEqual(self.failure(report), [])
        self.assertEqual(report["configs"][0]["decodable"], 1)
        self.assertEqual(self.verdict(strand, [strand] * 5 + [variant] * 5, "--no-extra-step")["configs"][0]["decodable"], 1)

    def test_coverage_step_is_a_hotspot_and_can_be_waived(self):
        strand = unique_sequence(60, 5)
        # Reads ending at base 29 stop covering k-mers from index 23 onward.
        reads = [strand[:30]] * 16 + [strand] * 4
        report = self.verdict(strand, reads)
        self.assertEqual(self.failure(report), ["ratio_drop"])
        self.assertEqual(report["ratioHotspots"], [{"kmer": 24, "count": 1, "fraction": 1.0}])
        waived = self.verdict(strand, reads, "--waive-kmers", 24)
        self.assertEqual(waived["configs"][0]["decodable"], 1)
        self.assertEqual(waived["configs"][0]["waive"], [24])

    def test_unobserved_seed_and_gap(self):
        strand = unique_sequence(60, 6)
        self.assertEqual(self.failure(self.verdict(strand, [strand[20:]] * 5)), ["seed_missing"])
        gapped = [strand[:25], strand[27:]]
        self.assertEqual(self.failure(self.verdict(strand, gapped * 5)), ["missing"])

    def test_malformed_strands_are_reported_not_scored(self):
        strand = unique_sequence(60, 7)
        short = strand[:NEEDED - 1]
        invalid = strand[:20] + "N" + strand[21:]
        outside_walk = strand[:NEEDED + 2] + "N" + strand[NEEDED + 3:]
        reference = fasta(self.dir / "ref.fa", [("short", short), ("invalid", invalid),
                                                ("outside", outside_walk)])
        read_file = fasta(self.dir / "reads.fa", [("r", strand)] * 5)
        out = self.dir / "strands.tsv"
        result = run("decodability", "-k", K, *LAYOUT, "--per-strand", out, reference, read_file)
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = {row["strand"]: row for row in csv.DictReader(out.read_text().splitlines(), delimiter="\t")}
        self.assertEqual(rows["short"]["failure"], "too_short")
        self.assertEqual(rows["invalid"]["failure"], "invalid_base")
        self.assertEqual(rows["outside"]["failure"], "ok")

    def test_configurations_share_one_count_and_fill_per_strand_columns(self):
        strand = unique_sequence(60, 8)
        reference = fasta(self.dir / "ref.fa", [("s1", strand)])
        read_file = fasta(self.dir / "reads.fa", [("r", strand)])
        out = self.dir / "strands.tsv"
        result = run("decodability", "-k", K, *LAYOUT, "--json", "--per-strand", out,
                     "--config", "1:2.55", "--config", "0:4:-:noextra", reference, read_file)
        self.assertEqual(result.returncode, 0, result.stderr)
        configs = json.loads(result.stdout)["configs"]
        self.assertEqual([c["decodable"] for c in configs], [0, 1])
        self.assertEqual([c["extraStep"] for c in configs], [True, False])
        row = next(csv.DictReader(out.read_text().splitlines(), delimiter="\t"))
        self.assertEqual((row["failure"], row["config0_decodable"], row["config1_decodable"]),
                         ("below_cutoff", "0", "1"))

    def test_table_output(self):
        strand = unique_sequence(60, 9)
        reference = fasta(self.dir / "ref.fa", [("s1", strand)])
        read_file = fasta(self.dir / "reads.fa", [("r", strand)] * 5)
        result = run("decodability", "-k", K, *LAYOUT, reference, read_file)
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = list(csv.DictReader(result.stdout.splitlines(), delimiter="\t"))
        self.assertEqual((rows[0]["Decodable"], rows[0]["Waived"], rows[0]["ExtraStep"]), ("1", "-", "yes"))

    def test_kernel_matches_the_command_line(self):
        strand = unique_sequence(60, 10)
        reference = fasta(self.dir / "ref.fa", [("s1", strand)])
        read_file = fasta(self.dir / "reads.fa", [("r", strand)] * 5)
        query = f"decodability {PRIMER} {INDEX} {PATH_LENGTH} 1:2.55,99:2.55 {reference}\nexit\n"
        result = run("kernel", "-k", K, read_file, stdin=query)
        self.assertEqual(result.returncode, 0, result.stderr)
        event = next(e for e in map(json.loads, result.stdout.splitlines()) if e["type"] == "decodability")
        self.assertEqual([c["decodable"] for c in event["configs"]], [1, 0])
        self.assertEqual(event["rows"], [{"name": "s1", "failure": "ok", "position": -1}])

    def test_kernel_reports_bad_queries_and_keeps_running(self):
        strand = unique_sequence(60, 11)
        reference = fasta(self.dir / "ref.fa", [("s1", strand)])
        read_file = fasta(self.dir / "reads.fa", [("r", strand)] * 5)
        queries = [f"decodability {PRIMER} {INDEX}", f"decodability {PRIMER} {INDEX} {PATH_LENGTH} x:y {reference}",
                   f"decodability {PRIMER} {INDEX} {PATH_LENGTH} 1:2.55 {self.dir / 'absent.fa'}",
                   f"decodability 1 1 {PATH_LENGTH} 1:2.55 {reference}", "summary", "exit"]
        result = run("kernel", "-k", K, read_file, stdin="\n".join(queries) + "\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(sum(e["type"] == "error" for e in events), 4)
        self.assertTrue(any(e["type"] == "summary" for e in events))

    def test_bloom_index_cannot_see_off_path_successors(self):
        strand = unique_sequence(60, 12)
        reference = fasta(self.dir / "ref.fa", [("s1", strand)])
        read_file = fasta(self.dir / "reads.fa", [("r", strand)] * 5)
        queries = (f"decodability {PRIMER} {INDEX} {PATH_LENGTH} 1:2.55:-:extra {reference}\n"
                   f"decodability {PRIMER} {INDEX} {PATH_LENGTH} 1:2.55:-:noextra {reference}\nexit\n")
        result = run("kernel", "-k", K, "--bloom", "--bloom-reference", reference, read_file, stdin=queries)
        self.assertEqual(result.returncode, 0, result.stderr)
        events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertTrue(any(e["type"] == "error" and "Bloom" in e["message"] for e in events))
        self.assertEqual(next(e for e in events if e["type"] == "decodability")["configs"][0]["decodable"], 1)

    def test_rejected_arguments(self):
        strand = unique_sequence(60, 13)
        reference = fasta(self.dir / "ref.fa", [("s1", strand)])
        read_file = fasta(self.dir / "reads.fa", [("r", strand)])
        for options in (("-k", 32), ("-k", "abc"), ("-t", 0), ("-r", 0.5), ("-c", "x"), ("--primer", 1, "--index-length", 1),
                        ("--waive-kmers", "a"), ("--waive-kmers", "1,"), ("--config", "1"), ("--config", "1:0.5"),
                        ("--config", "1:2:3:maybe"), ("--unknown",)):
            with self.subTest(options=options):
                result = run("decodability", "-k", K, *LAYOUT, *options, reference, read_file)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
        self.assertEqual(run("decodability", "--help").returncode, 0)
        self.assertNotEqual(run("decodability").returncode, 0)
        self.assertNotEqual(run("decodability", "-k", K, *LAYOUT, reference, self.dir / "absent.fa").returncode, 0)
        self.assertNotEqual(run("decodability", "-k", K, *LAYOUT, self.dir / "absent.fa", read_file).returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=1)
