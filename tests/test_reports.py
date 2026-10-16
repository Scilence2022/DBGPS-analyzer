#!/usr/bin/env python3
"""Verify that JSON, Markdown and HTML reports describe the same analysis."""
from html.parser import HTMLParser
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "dstoreqc"
DATA = ROOT / "tests" / "data"


def run(*args):
    return subprocess.run([str(CLI), *map(str, args)], cwd=ROOT,
                          capture_output=True, text=True, timeout=120)


class ReportHTML(HTMLParser):
    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.tags, self.resources, self.rows, self.text = [], [], [], []
        self.row, self.cell = None, None
        self.feed(html)
        self.close()

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        self.resources += [value for key, value in attrs if key in ("src", "href")]
        if tag == "tr": self.row = []
        if tag in ("th", "td"): self.cell = []

    def handle_data(self, data):
        self.text.append(data)
        if self.cell is not None: self.cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("th", "td") and self.row is not None:
            self.row.append("".join(self.cell))
            self.cell = None
        if tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None


class ReportFormats(unittest.TestCase):
    def report(self, format, *files, extra=()):
        result = run("report", "-k", "8", "-p", "0", "--format", format, *extra, *files)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_all_formats_preserve_counts_and_metric_rows(self):
        files = (DATA / "links.fa", DATA / "ngs.fa")
        payload = json.loads(self.report("json", *files))
        default = run("report", "-k", "8", "-p", "0", *files)
        self.assertEqual(json.loads(default.stdout), payload)
        markdown = self.report("markdown", *files)
        html = ReportHTML(self.report("html", *files))
        for label, key in [("Reference strands", "totalStrands"), ("Passed strands", "passedCount"),
                           ("Entangled strands", "filteredCount"), ("Skipped strands", "skippedCount"),
                           ("Cross-link contributions", "crossLinks")]:
            value = str(payload["reference"][key])
            self.assertIn(f"| {label} | {value} |", markdown)
            self.assertIn([label, value], html.rows)
        for row in payload["analyzer"]["rows"]:
            values = [f"{row['ratio']:.6f}"]
            values += [str(row[key]) for key in ("coverage", "total", "paths", "noise", "exist", "lost")]
            values += ["n/a" if row[key] is None else f"{row[key]:.6f}" for key in ("sm", "kd", "kn")]
            self.assertIn("| " + " | ".join(values) + " |", markdown)
            self.assertIn(values, html.rows)
        self.assertIn("- s1\n- s2\n", markdown)
        self.assertNotIn("script", html.tags)
        self.assertEqual(html.resources, [])  # Standalone report works offline.
        self.assertIn("html", html.tags)
        self.assertIn("title", html.tags)

    def test_no_reads_and_markdown_alias(self):
        markdown = self.report("markdown", DATA / "links.fa")
        self.assertEqual(markdown, self.report("md", DATA / "links.fa"))
        for content in (markdown, self.report("html", DATA / "links.fa")):
            self.assertIn("No NGS reads supplied", content)
            self.assertNotIn("| Ratio |", content)

    def test_output_files_leave_stdout_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            for format, extension in (("json", "json"), ("markdown", "md"), ("html", "html")):
                output = Path(tmp) / ("report." + extension)
                expected = self.report(format, DATA / "links.fa", DATA / "ngs.fa")
                result = run("report", "-k", "8", "-p", "0", "--format", format,
                             "--output", output, DATA / "links.fa", DATA / "ngs.fa")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertEqual(output.read_text(), expected)

    def test_special_names_and_paths_are_escaped(self):
        with tempfile.TemporaryDirectory() as tmp:
            reference = Path(tmp) / '参考|<script>&".fa'
            reference.write_text('>链|<img/src=x/onerror=alert(1)>\nAAAAAAAA\n'
                                 '>链二*`\\\nTTTTTTTT\n>通过```<script>\nCCCCCCCC\n')
            for format in ("json", "markdown", "html"):
                content = self.report(format, reference, extra=("--include-passed",))
                if format == "json":
                    payload = json.loads(content)
                    self.assertEqual(payload["referenceFile"], str(reference))
                    self.assertEqual(payload["reference"]["filteredNames"][0], "链|<img/src=x/onerror=alert(1)>")
                    self.assertIn("通过```<script>", payload["reference"]["passedFasta"])
                elif format == "html":
                    parsed = ReportHTML(content)
                    self.assertNotIn("img", parsed.tags)
                    self.assertNotIn("script", parsed.tags)
                    self.assertIn('参考|<script>&".fa', "".join(parsed.text))
                    self.assertIn("&lt;img/", content)
                else:
                    self.assertIn("\\|", content)
                    self.assertNotIn("<img/", content)
                    self.assertIn("&lt;img/", content)
                    self.assertIn("    >通过```<script>\n    CCCCCCCC", content)

    def test_undefined_metrics_are_readable(self):
        for format in ("markdown", "html"):
            result = run("report", "--format", format, "-k", "8", "-p", "100",
                         DATA / "links.fa", DATA / "ngs.fa")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("n/a", result.stdout)
            self.assertNotIn("nan", result.stdout)
            self.assertIn("Skipped strands", result.stdout)

    def test_passed_fasta_is_opt_in(self):
        for format in ("markdown", "html"):
            self.assertNotIn("Passed FASTA", self.report(format, DATA / "links.fa"))
            self.assertIn("Passed FASTA", self.report(format, DATA / "links.fa", extra=("--include-passed",)))

    def test_invalid_options_and_failed_analysis_do_not_overwrite_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "report.html"
            output.write_text("preserve this report")
            for args in (("--format", "pdf"), ("--format",), ("--output",),
                         ("--json", "--format", "html"), ("--format", "markdown", "--json")):
                result = run("report", DATA / "links.fa", *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
            for format in ("json", "markdown", "html"):
                result = run("report", "--format", format, "-o", output, DATA / "links.fa", "missing-reads.fa")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(output.read_text(), "preserve this report")
            for command in ("links", "filter"):
                self.assertNotEqual(run(command, "--format", "html", DATA / "links.fa").returncode, 0)

    def test_output_cannot_overwrite_inputs_or_their_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            reference = Path(tmp) / "reference.fa"
            original = ">a\nAAAAAAAA\n"
            reference.write_text(original)
            linked = Path(tmp) / "linked.html"
            linked.symlink_to(reference)
            for output in (reference, linked):
                result = run("report", "--format", "html", "-o", output, reference)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("must not overwrite input", result.stderr)
                self.assertEqual(reference.read_text(), original)


if __name__ == "__main__":
    unittest.main(verbosity=2)
