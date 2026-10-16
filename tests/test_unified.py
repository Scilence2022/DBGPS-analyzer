#!/usr/bin/env python3
"""Single-executable CLI and combined-reference regression tests."""
import gzip
import json
from collections import Counter
from pathlib import Path
import random
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "tests" / "data"
CLI = ROOT / "dstoreqc"


def run(*args, stdin=None, binary=CLI, cwd=ROOT):
    return subprocess.run([str(binary), *map(str, args)], input=stdin,
                          capture_output=True, text=True, cwd=cwd, timeout=120)


class UnifiedCLI(unittest.TestCase):
    def json_result(self, *args):
        result = run(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout), result

    def test_dispatch_help_and_errors(self):
        for command in ((), ("analyze",), ("links",), ("filter",), ("kernel",), ("report",)):
            with self.subTest(command=command):
                result = run(*command, "--help")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("Usage:", result.stdout + result.stderr)
                self.assertNotEqual(run(*command).returncode, 0)
        self.assertNotEqual(run("typo").returncode, 0)
        for command in ("links", "filter", "report"):
            for options in (("-k", "32"), ("-k", "abc"), ("-k", "0"), ("-p", "-1"),
                            ("-p", "999999999999"), ("--unknown",), ("--json=true",), ("-k",)):
                with self.subTest(command=command, options=options):
                    result = run(command, DATA / "links.fa", *options)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, "")
        for command, options in (("links", ("-s",)), ("filter", ("-s", "--json")),
                                 ("report", ("-m", "1")), ("filter", ("--include-passed",)),
                                 ("report", ("-t", "0")), ("kernel", ("-c", "0")),
                                 ("kernel", ("-r", "2")), ("kernel", ("-o", "unused"))):
            self.assertNotEqual(run(command, *options, DATA / "links.fa").returncode, 0)

    def test_single_executable_and_defaults(self):
        self.assertFalse(CLI.is_symlink())
        for old_name in ("DBGPS-analyzer", "DBGPS-links", "DBGPS-seq-filter", "dbgps"):
            self.assertFalse((ROOT / old_name).exists())
        # Dispatch depends only on the subcommand, even after copying/renaming.
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("renamed-dstoreqc", "DBGPS-links"):
                copied = Path(tmp) / name
                shutil.copy2(CLI, copied)
                self.assertIn("Usage: dstoreqc <command>", run(binary=copied).stderr)
                result = run("links", "-k", "8", DATA / "links.fa", binary=copied)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "Total cross links 3\n")
        for command in ("analyze", "kernel"):
            self.assertNotEqual(run(command, "-i", DATA / "reads.fa").returncode, 0)
        links, _ = self.json_result("links", "--json", "-k", "8", DATA / "links.fa")
        filtered, _ = self.json_result("filter", "--json", "-k", "8", DATA / "links.fa")
        self.assertEqual(links["primerLen"], 0)
        self.assertEqual(links["crossLinks"], 3)
        self.assertEqual(filtered["primerLen"], 18)
        self.assertEqual(filtered["skippedCount"], 3)
        self.assertEqual(filtered["passedCount"], 0)

    def test_kernel_protocol_and_bloom(self):
        for options in ([], ["--bloom", "--bloom-reference", str(DATA / "strands.fa")]):
            commands = "summary\nsequenceSummary ACGTACGTACGT\nexit\n"
            actual = run("kernel", "-k", "4", *options, DATA / "reads.fa", stdin=commands)
            self.assertEqual(actual.returncode, 0, actual.stderr)
            events = [json.loads(line) for line in actual.stdout.splitlines()]
            self.assertEqual(events[0]["type"], "ready")
            self.assertEqual(events[-1]["type"], "bye")
            self.assertEqual(events[0]["k"], 4)
            self.assertEqual(events[0].get("indexScope", "full"), "reference" if options else "full")

    def test_filter_json_returns_both_outputs_once(self):
        payload, result = self.json_result("filter", "--json", "-k", "8", "-p", "0", DATA / "links.fa")
        self.assertEqual(payload["filteredNames"], ["s1", "s2"])
        self.assertEqual(payload["passedFasta"], run("filter", "-k", "8", "-p", "0", DATA / "links.fa").stdout)
        self.assertEqual(payload["filteredCount"], 2)
        self.assertEqual(payload["passedCount"], 1)
        self.assertEqual(payload["totalStrands"], 3)
        self.assertEqual(result.stderr.count("Counting reference strand k-mers"), 1)

    def test_combined_report_and_metrics(self):
        payload, result = self.json_result("report", "-k", "8", "-p", "0", "--include-passed",
                                          DATA / "links.fa", DATA / "ngs.fa", DATA / "ngs.fa")
        reference, _ = self.json_result("filter", "--json", "-k", "8", "-p", "0", DATA / "links.fa")
        self.assertEqual(payload["reference"], reference)
        self.assertEqual(len(payload["ngsFiles"]), 2)
        batch = run("analyze", "-k", "8", DATA / "links.fa", DATA / "ngs.fa", DATA / "ngs.fa")
        table = [line for line in batch.stdout.splitlines() if "\t" in line and not line.startswith("Ratio")]
        row = payload["analyzer"]["rows"][0]
        self.assertEqual(list(row.values()), [float(value) for value in table[0].split("\t")])
        self.assertEqual(result.stderr.count("Counting reference strand k-mers"), 1)
        without_reads, _ = self.json_result("report", "-k", "8", "-p", "0", DATA / "links.fa")
        self.assertIsNone(without_reads["analyzer"])
        self.assertNotIn("passedFasta", without_reads["reference"])

    def test_membership_dedup_reverse_complement_and_thresholds(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "repeats.fa"
            file.write_text(">a\nAAAAAAAA\n>b\nTTTTTTTT\n>c\nAAAAAA\n>d\nCCCCCCCC\n")
            report, _ = self.json_result("report", "-k", "4", "-p", "0", "--links-threshold", "2",
                                         "--filter-max-links", "0", file)
            reference = report["reference"]
            self.assertEqual(reference["crossLinks"], 2)  # n-1, not n*(n-1)/2 or occurrence count
            self.assertEqual(reference["filteredNames"], ["a", "b", "c"])
            self.assertEqual(reference["passedCount"], 1)
            relaxed, _ = self.json_result("report", "-k", "4", "-p", "0", "--links-threshold", "3",
                                          "--filter-max-links", "2", file)
            self.assertEqual(relaxed["reference"]["crossLinks"], 0)
            self.assertEqual(relaxed["reference"]["filteredCount"], 0)
            self.assertEqual(relaxed["reference"]["passedCount"], 4)

    def test_report_trimming_matches_analyzing_trimmed_reference(self):
        with tempfile.TemporaryDirectory() as tmp:
            ref, trimmed, reads = [Path(tmp) / name for name in ("ref.fa", "trimmed.fa", "reads.fq")]
            ref.write_text(">one\nAAAACCCCCCCCTTTT\n>two\nAAAACACACACATTTT\n>short\nAAAA\n")
            trimmed.write_text(">one\nCCCCCCCC\n>two\nCACACACA\n>short\n\n")
            reads.write_text("@r\nCCCCCCCC\n+\nIIIIIIII\n")
            payload, _ = self.json_result("report", "-k", "4", "-p", "4", "--include-passed", ref, reads)
            reference = payload["reference"]
            self.assertEqual(reference["skippedCount"], 1)
            self.assertEqual(reference["passedCount"], 2)
            self.assertEqual(reference["crossLinks"], 0)
            self.assertIn("AAAACCCCCCCCTTTT", reference["passedFasta"])  # scoring trims, output retains primers
            batch = run("analyze", "-k", "4", trimmed, reads)
            expected = [line.split("\t") for line in batch.stdout.splitlines() if line.startswith("0.00\t")][0]
            row = payload["analyzer"]["rows"][0]
            self.assertEqual(list(row.values()), [float(value) for value in expected])
            self.assertEqual(payload["analyzer"]["primerLen"], 4)
            all_short, _ = self.json_result("report", "-k", "4", "-p", "100", ref, reads)
            self.assertEqual(all_short["reference"]["passedCount"], 0)
            self.assertEqual(all_short["reference"]["skippedCount"], 3)
            self.assertIsNone(all_short["analyzer"]["rows"][0]["kd"])
            self.assertIsNone(all_short["analyzer"]["rows"][0]["kn"])

    def test_gzip_fastq_unicode_and_json_escaping(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / '参考 "library".fq.gz'
            names = ['链"一\\', "链二", "通过"]
            sequences = ["AAAAAAAA", "TTTTTTTT", "CCCCCCCC"]
            text = "".join(f"@{name}\n{seq}\n+\n{'I' * len(seq)}\n" for name, seq in zip(names, sequences))
            with gzip.open(file, "wt", encoding="utf-8") as handle:
                handle.write(text)
            payload, _ = self.json_result("report", "-k", "4", "-p", "0", "--include-passed", file)
            self.assertEqual(payload["referenceFile"], str(file))
            self.assertEqual(payload["reference"]["filteredNames"], names[:2])
            self.assertEqual(payload["reference"]["passedFasta"], ">通过\nCCCCCCCC\n")
            self.assertEqual(payload["reference"]["crossLinks"], 1)

    def test_counter_layouts_remain_separate(self):
        with tempfile.TemporaryDirectory() as tmp:
            ref, reads = [Path(tmp) / name for name in ("ref.fa", "reads.fa")]
            ref.write_text("".join(f">s{i}\nAAAA\n" for i in range(1100)))
            reads.write_text("".join(f">r{i}\nAAAA\n" for i in range(2000)))
            report, _ = self.json_result("report", "-k", "4", "-p", "0", ref, reads)
            self.assertEqual(report["reference"]["crossLinks"], 1022)  # legacy 10-bit saturation
            self.assertEqual(report["reference"]["filteredCount"], 1100)
            kernel = run("kernel", "-k", "4", reads, stdin="kmer AAAA 0 0\nexit\n")
            events = [json.loads(line) for line in kernel.stdout.splitlines()]
            self.assertEqual(next(event for event in events if event["type"] == "kmer")["coverage"], 2000)

    def test_reference_metrics_against_independent_oracle(self):
        rng = random.Random(20261016)
        sequences = ["".join(rng.choices("ACGTN", k=rng.randrange(1, 45))) for _ in range(80)]
        sequences += ["AAAAAA", "TTTTTT", "AAAAAAAA", "CCCCCC"]
        complement = str.maketrans("ACGT", "TGCA")
        with tempfile.TemporaryDirectory() as tmp:
            ref = Path(tmp) / "random.fa"
            ref.write_text("".join(f">s{i}\n{seq}\n" for i, seq in enumerate(sequences)))
            for k, primer in ((1, 0), (3, 0), (4, 2), (8, 6), (31, 1)):
                sets, skipped = [], set()
                for i, seq in enumerate(sequences):
                    body = seq[primer:len(seq) - primer] if primer else seq
                    if len(body) < k:
                        skipped.add(i)
                    keys = set()
                    for pos in range(len(body) - k + 1):
                        key = body[pos:pos + k]
                        if "N" not in key:
                            keys.add(min(key, key.translate(complement)[::-1]))
                    sets.append(keys)
                counts = Counter(key for keys in sets for key in keys)
                for threshold, max_links in ((1, 0), (2, 1), (5, 4)):
                    report, _ = self.json_result("report", "-k", str(k), "-p", str(primer),
                                                 "--links-threshold", str(threshold),
                                                 "--filter-max-links", str(max_links), ref)
                    actual = report["reference"]
                    filtered = [f"s{i}" for i, keys in enumerate(sets) if i not in skipped
                                and max((counts[key] - 1 for key in keys), default=0) > max_links]
                    self.assertEqual(actual["filteredNames"], filtered)
                    self.assertEqual(actual["skippedCount"], len(skipped))
                    self.assertEqual(actual["passedCount"], len(sequences) - len(skipped) - len(filtered))
                    self.assertEqual(actual["crossLinks"], sum(n - 1 for n in counts.values() if n > threshold))

    def test_dash_prefixed_filenames_are_not_reparsed_as_options(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "-reference.fa").write_text(">a\nAAAAAA\n")
            Path(tmp, "-reads.fa").write_text(">r\nAAAAAA\n")
            result = run("report", "-k", "4", "-p", "0", "--", "-reference.fa", "-reads.fa", cwd=tmp)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["analyzer"]["rows"][0]["sm"], 1)

    def test_missing_and_malformed_inputs_fail_without_success_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "truncated.fq"
            bad.write_text("@broken\nACGTACGT\n+\nII\n")
            for args in (("report", "missing.fa"), ("report", DATA / "links.fa", "missing.fq"),
                         ("report", bad), ("filter", "--json", bad), ("links", "--json", bad)):
                with self.subTest(args=args):
                    result = run(*args)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
