# DStoreQC: DNA Storage Quality Control

A specialized suite of high-performance tools for **data quality analysis in DNA information storage systems**. This repository provides tools to calculate sequencing metrics, detect inter-strand cross-links, and filter out entangled sequences.

DStoreQC is a standalone quality-control tool, distinct from the published DBGPS DNA storage assembly program. This codebase was split out from the original DBGPS DNA information storage encoding/decoding framework, extracting and optimizing the components specifically designed for quality control, coverage analysis, and data filtering.

---

## Table of Contents
1. [Overview of Tools](#overview-of-tools)
2. [Workflow & Theory](#workflow--theory)
3. [Installation & Building](#installation--building)
4. [Tool Guides & Usage](#tool-guides--usage)
   - [Analyze and Kernel](#analyze-and-kernel)
   - [Links](#links)
   - [Filter](#filter)
5. [License](#license)

---

## Overview of Tools

This project builds one C executable, **`dstoreqc`**, with `analyze`,
`decodability`, `links`, `filter`, `kernel`, and `report` subcommands:

1. **`dstoreqc analyze` / `dstoreqc kernel`** (analysis module: [dstoreqc_analyzer.c](dstoreqc_analyzer.c)): Evaluates sequencing datasets against expected target strands, calculating critical quality metrics such as strand recovery rate ($S_m$), k-mer noise ratio ($K_n$), and k-mer dropout rate ($K_d$).
2. **`dstoreqc decodability`** (rule: [dstoreqc_decodability.h](dstoreqc_decodability.h)): Predicts which strands a DBGPS-style de Bruijn graph decoder will return, and where each of the others fails, from k-mer coverage alone and for any number of decoder settings at once.
3. **`dstoreqc links`** (reference module: [dstoreqc_reference.c](dstoreqc_reference.c)): Detects and counts cross-links between DNA strands to identify repeated patterns and sequence entanglement.
4. **`dstoreqc filter`** (reference module: [dstoreqc_reference.c](dstoreqc_reference.c)): Screens out and filters entangled or highly cross-linked strands to prepare sequencing data for cleaner assembly.

---

## Workflow & Theory

In DNA data storage, errors and bias in synthesis, PCR amplification, and sequencing lead to uneven coverage, dropout, and chimera formation (strand entanglement). These tools help evaluate and filter sequencing data:

### Key Metrics
- **Strand Recovery Rate ($S_m$)**: The percentage of target DNA strands that are fully covered by sequencing reads (given a coverage ratio threshold).
- **k-mer Dropout Rate ($K_d$)**: The proportion of expected k-mers from the target sequences that are missing in the sequencing reads.
- **k-mer Noise Ratio ($K_n$)**: The ratio of noise k-mers (observed in the sequencing data but not belonging to the target sequences) to the valid target k-mers.

---

## Installation & Building

### Prerequisites
- GCC compiler supporting C99/C++11
- `zlib` development libraries (for reading compressed `.gz` files)
- POSIX threads (`pthread`)

### Building the Software
Clone this repository and compile using the [Makefile](Makefile):
```bash
git clone https://github.com/Scilence2022/DBGPS-analyzer.git
cd DBGPS-analyzer
make
```

`make` builds a single `dstoreqc` executable. Every operation uses a subcommand.
Use `make -j4` for parallel compilation or `make help` for build targets.
Object files and generated header dependencies live in `.build/`; changing
the compiler, flags, or ASan/native settings automatically rebuilds the program.
For installation, copy `dstoreqc` to a directory on your PATH. The desktop app
packages the same executable; no links or extra executables are required.

The shared k-mer / hash-table primitives live in [`dstoreqc_core.h`](dstoreqc_core.h).
[`dstoreqc_reference.c`](dstoreqc_reference.c) owns the common reference-library
index used by links and filtering. The analyzer remains a separate module:
reference counts measure strand membership (one contribution per canonical
k-mer per record, saturating at 1023), whereas NGS counts measure k-mer
occurrences (saturating at 16383). These counters are kept separate.

To build the executable directly:
```bash
make dstoreqc
```

---

## Tool Guides & Usage

### Unified CLI

```bash
./dstoreqc analyze -k 31 reference.fa reads.fq.gz
./dstoreqc links -k 31 -p 18 reference.fa
./dstoreqc filter -k 31 -p 18 reference.fa > passed.fa
./dstoreqc kernel -k 31 reads.fq.gz
./dstoreqc report -k 31 -p 18 reference.fa reads.fq.gz > report.json
```

Use `./dstoreqc --help` or `./dstoreqc <command> --help` for options. All commands
accept FASTA/FASTQ, optionally gzip-compressed. The CLI reference input must be
FASTA/FASTQ; the desktop app also converts tab-delimited references.
`analyze`, `links`, and `filter` produce text by default. Use `kernel` to
start the JSON Lines query protocol, with optional Bloom counting. The operation
is selected only by its subcommand: there is no executable-name dispatch or
`-i` mode switch. Use `--` before filenames that start with a dash.

`filter --json` emits counts, `filteredNames`, and `passedFasta` together, so
callers can display filtered names and save passed sequences from one run.
`links --json` emits the cross-link total and reference/skip counts.
The text-mode `filter -s` option cannot be combined with `--json`.

`report` supports **JSON**, **Markdown**, and standalone **HTML** reports.
JSON remains the default and contains `reference` and `analyzer` fields.
NGS reads are optional; without them, `analyzer` is `null`. With reads, its
`rows` contain Sm/Kn/Kd metrics using the analyzer's default coverage and ratio
cutoffs. Undefined numeric metrics are JSON `null` and appear as `n/a` in
Markdown and HTML. All three formats use the same analysis results.

```bash
./dstoreqc report --format markdown -o report.md -k 31 -p 18 reference.fa reads.fq.gz
./dstoreqc report --format html -o report.html -k 31 -p 18 reference.fa reads.fq.gz
./dstoreqc report --format json -o report.json -k 31 -p 18 reference.fa reads.fq.gz
```

`--format md` is an alias for `--format markdown`. Without `-o` / `--output`,
the report is written to stdout for shell redirection. HTML includes its styles
and needs no network access. Markdown and HTML include inputs, settings,
reference/entanglement counts, coverage metrics, filtered names and metric
definitions. `--include-passed` also includes the original passed FASTA.
Output files are opened after analysis and rendering succeed; an output path
that points to a reference or reads input is rejected.

```bash
# Build the reference index once for cross-links and filtering, without NGS.
./dstoreqc report -k 8 -p 0 tests/data/links.fa

# Set independent thresholds; include original passed FASTA in the JSON.
./dstoreqc report --links-threshold 1 --filter-max-links 0 --include-passed \
  -k 8 -p 0 tests/data/links.fa tests/data/ngs.fa
```

The `reference` object reports `totalStrands`, `passedCount`, `filteredCount`,
`skippedCount`, `filteredNames`, `crossLinks`, and the k/primer/threshold settings.
`--include-passed` adds `passedFasta` to JSON and a FASTA section to Markdown/HTML; scoring ignores primers but FASTA output
retains each passed record's original sequence. A cross-link total sums `n - 1`
for each canonical k-mer with strand count `n > linksThreshold`. Filtering rejects
a record if any of its k-mers has `n - 1 > filterMaxLinks`.

Primer defaults remain **0 bp** for `links` and **18 bp per end** for `filter`
and `report`. Standalone `analyze` preserves its original untrimmed reference
behavior. In `report`, `-p` applies to both reference entanglement and the
reference sequences scored for Sm/Kn/Kd; `-t` and `-L` control NGS counting.
Records shorter than k after trimming are skipped for entanglement and are
excluded from `passedCount`. For Sm, all reference records remain in the
denominator, and unscorable records cannot count as recovered. Accordingly,
reports using nonzero `-p` may differ from the former desktop report, which
trimmed reference sequences only for links/filtering.

### Analyze and Kernel

Computes coverage metrics ($S_m$, $K_n$, $K_d$) by comparing a pool of target/designed strands with NGS sequencing files.

#### Features
- Support for multi-threaded k-mer counting.
- Coverage ratio range iteration and step size control.
- Output prefix options for logs, coverage details, coverage ratios, ratio ranges, and $S_m, K_d, K_n$ values.
- Interactive JSON Lines diagnostics kernel for k-mer coverage, upstream/downstream De Bruijn Graph neighbors, and strand path completeness.

#### Usage
```bash
dstoreqc analyze [options] <Strand seq file> <NGS files>
dstoreqc kernel [options] <NGS files>
```
*Supported formats: `.fa`, `.fq`, `.fa.gz`, `.fq.gz`*

#### Options
| Option | Argument | Description | Default |
|:---|:---|:---|:---|
| `-k` | `INT` | k-mer size | `31` |
| `-t` | `INT` | Number of threads for multi-threading | `3` |
| `-L` | `INT` | Maximum read length for k-mer counting | `200` |
| `--bloom` | | Optional exact reference-only counting with a blocked Bloom prefilter; global Noise/Kn unavailable | off |
| `--bloom-bits` | `INT` | Minimum allocated filter bits per target key (4-64; power-of-two allocation) | `16` |
| `--bloom-reference` | `FILE` | Reference FASTA/FASTQ required for `kernel --bloom`; standalone uses its positional reference | none |
| `-r` | `FLOAT` | Maximum coverage ratio (0 = no limitation) | `0.0` |
| `-R` | `FLOAT` | Upper bound for coverage ratio range iteration | `0.0` |
| `-I` | `FLOAT` | Step size for coverage ratio iteration | `0.20` |
| `-c` | `INT` | Minimum coverage cutoff | `0` |
| `-C` | `INT` | Maximum coverage cutoff | `0` |
| `-s` | `INT` | Number of initial ratio values to ignore | `0` |
| `-o` | `STR` | Output prefix for additional files | `None` |

#### Output Files (when using `-o STR`)
- `STR.cov_details`: Detailed k-mer coverage values per strand.
- `STR.cov_ratios`: Calculated inter-k-mer coverage ratios per strand.
- `STR.ratio_ranges`: Aggregated minimum and maximum ratios tracked.
- `STR.SmKdKn`: Complete tab-delimited table of calculated $S_m$, $K_d$, and $K_n$ metrics.

#### Interactive Kernel Protocol

`kernel` accepts `-k`, `-t`, `-L`, and the Bloom options. Ratio grids, coverage
cutoffs and output-prefix options belong to `analyze`.

Interactive mode builds the sequencing k-mer coverage table from one or more NGS files, then accepts one command per line on stdin and writes one JSON object per line on stdout.

Optional low-memory counting: use `dstoreqc analyze --bloom reference.fa reads.fq.gz`,
or `dstoreqc kernel --bloom --bloom-reference reference.fa reads.fq.gz` for the
kernel. Target coverage, Sm and Kd remain exact up to the existing count cap;
global Noise/Kn and graph queries are unavailable. Out-of-reference sequence
queries return errors rather than false dropout. The desktop exposes the same
opt-in mode before kernel startup. See [Bloom backend selection, scope and validation](docs/bloom-filter.md).

```bash
make dstoreqc
printf 'summary\nkmer ACGTACGT 2 2\nsequence ACGTACGTACGT\nexit\n' \
  | ./dstoreqc kernel -k 8 reads.fa
```

Supported commands:

| Command | Description |
|:---|:---|
| `summary` | Return k, read-length limit, distinct k-mer count, and total saturated k-mer coverage. |
| `kmer <ACGT...> [upstreamDepth] [downstreamDepth]` | Query one DNA sequence. If the sequence is exactly k bases, it is used directly. If it is longer than k, the leftmost k-mer anchors upstream analysis and the rightmost k-mer anchors downstream analysis. Returns canonical coverage, one-step neighbors, and optional multi-step covered branch trees. Depth values are clamped to 0-6. |
| `index <DECIMAL> <baseLength> [upstreamDepth] [downstreamDepth]` | Convert a decimal index to base-4, decode 0/1/2/3 with the default A/C/G/T scheme, left-pad with A bases when the decoded length is shorter than `baseLength`, then run greedy upstream/downstream path search. If the decoded DNA is still shorter than k, covered k-mers matching that prefix are returned as multiple greedy start k-mers up to the start limit. |
| `sequence <ACGT...>` | Query every ordered k-mer in a DNA strand and return coverage, missing positions, path completeness, and adjacent coverage ratios. |
| `decodability <primerFront> <indexLength> <pathLength> <config[,config...]> <reference.fasta>` | Evaluate the decodability predicate. See [Decodability](#decodability). |
| `help` | Return supported commands. |
| `exit` | Stop the interactive kernel. |

### Decodability

A de Bruijn graph decoder decides everything from k-mer coverage, so whether it
returns a strand can be computed without running it. `dstoreqc decodability`
writes the DBGPS acceptance rule as a predicate over the coverage of each strand's
designed path, which needs the designed sequences and is meant for write-time
verification, process development and archive audits, not blind retrieval.

Walking from the k-mer that ends at the last index base, a successor of coverage
`x` after a node of coverage `y` is admitted when
`max(trunc(y/r), c+1) <= x <= min(trunc(y*r), 16383)`. A strand fails at the first
refused step, and is reported with the k-mer and the reason:

| Failure | Meaning |
|:---|:---|
| `seed_missing`, `missing` | The seed or a designed k-mer was never observed. |
| `below_cutoff` | A designed k-mer was observed, but not above the cutoff. |
| `ratio_drop`, `ratio_rise` | Coverage changed by more than the ratio window between adjacent k-mers. |
| `extra_step_none`, `extra_step_ambiguous` | DBGPS walks one step past the path end. That step found no admissible successor, or found several, which duplicates the candidate so the CRC cannot pick one. |
| `too_short`, `invalid_base` | The strand cannot hold the walk, or the walk contains a non-ACGT base. |

```bash
# Default DBGPS settings on 200-nt strands (18-nt primers, 16-nt index, 140-nt payload, 8-nt CRC)
./dstoreqc decodability -k 31 -t 16 --per-strand strands.tsv reference.fa reads.fq.gz

# Several settings from one count; per-strand output gets one column for each
./dstoreqc decodability -k 31 -t 16 --config 1:2.55 --config 1:4:50+120:noextra --json reference.fa reads.fq.gz
```

A configuration is `cutoff:ratio[:kmer+kmer|-[:extra|noextra]]`. Listed k-mers are
entered without the ratio test, keeping the cutoff; `noextra` models a walk that
stops at the path end. JSON output adds `ratioHotspots`, the k-mers holding at
least 10% of the first ratio failures of the first configuration. A hotspot is a
coverage step, usually a read-length boundary, not noise.

The prediction is exact only while the decoder's search stays within its limits.
With a wide ratio window it can exhaust its path budget, and the predicate becomes
an upper bound; a relaxed cutoff also admits rare CRC collisions on noise paths,
which the predicate does not model. A Bloom reference index holds no off-path
coverage, so it can only evaluate `noextra` configurations.

### Electron Desktop App

The Electron desktop app lives in [`desktop/`](desktop). It is organized into five top-level views (plus a Settings workspace), all wired to the C tools through the Electron main process:

| View | Purpose |
|:---|:---|
| **Batch QC** | Default first view: select encoded sequences (FASTA **or** tab-delimited) and automatically score **every** strand against the loaded sequencing k-mer table — one row per strand showing observed/total k-mers, path completeness, and min/mean/max coverage. Front/back primer regions are trimmed first; click any strand to drill into its full coverage profile, and export the whole table as CSV. Start the kernel directly using the shared controls above the scan, then click Analyze all. **Predict decoding** applies the [decoder acceptance rule](#decodability) to every strand, reports where strands are lost, and offers to waive k-mers that concentrate the ratio failures; it also adds a Decoder column to the table and the CSV. |
| **Interactive** | Share the kernel controls with Batch QC; start/stop the `dstoreqc kernel` JSON-Lines kernel; run k-mer, index, and sequence-path queries; visualize multi-step upstream/downstream De Bruijn graph trees. |
| **Cross-links** | Run `dstoreqc links` on a reference library and report cross-link contributions from shared k-mers, with k and minimum-shared-strands controls. |
| **Seq-Filter** | Run `dstoreqc filter --json` to screen entangled strands; choose max cross-links and whether to emit passed FASTA or the names of filtered strands; save the output to a file. |
| **Report** | Generate a **comprehensive diagnostics report** over a reference strand set: run `dstoreqc report` (including batch metrics when NGS reads are supplied), with headline metrics, rule-based verdicts, the Sm/Kd/Kn table, cross-link and entanglement summaries, an optional AI interpretation, and one-click export to HTML or Markdown. |

The desktop calls `dstoreqc` subcommands and packages a single executable. Report
uses one `dstoreqc report` process: cross-links and filtering share one reference
index, which is freed before optional NGS counting. Seq-Filter uses one
`dstoreqc filter --json` call for both filtered names and passed FASTA. Report
applies the chosen primer length to all reference scoring and displays skipped
records separately from passed and entangled records.

#### Input formats

The Encoded sequences picker selects the expected DNA storage sequences. It accepts two formats and auto-detects which one a file uses:

1. **FASTA** (`>name` headers followed by sequence lines), optionally gzip-compressed.
2. **Tab-delimited** index tables — one record per line as `Head-Index<TAB>DNA`, with an optional header row (e.g. `Head-Index   DNA`) that is skipped automatically:

   ```text
   Head-Index      DNA
   101010102       CCTGCAGAGTAGCATGTCATTGATTCTAGTGC...GACACTGATGCATCCG
   101010104       CCTGCAGAGTAGCATGTCATTGATTCTAGTGC...GACACTGATGCATCCG
   ```

   The first column becomes the strand name and the DNA column its sequence. Because the C tools read FASTA/FASTQ, tab-delimited inputs are converted to a temporary FASTA in the Electron main process before a tool runs.

#### Shared inputs

The **Inputs** bar above the views is shared by every tab, so each file and parameter is chosen once:

| Input | Used by |
|:---|:---|
| **Encoded sequences** (FASTA or tab-delimited) | Batch QC, Cross-links, Seq-Filter, Report, and Bloom encoded sequence mode |
| **Reads** (FASTA/FASTQ, optionally gzip) | The Interactive kernel and the Report (optional there). While the kernel runs, the same control adds files to the loaded index. **Clear reads** removes all read selections, stops counting or the running kernel, and clears counts and cached query/Batch QC results. |
| **k-mer, Threads, Read length** | The Interactive kernel and the Report (k-mer also Cross-links and Seq-Filter) |
| **Primer trim** (front / back) | Batch QC, Cross-links, Seq-Filter, Report |

Inputs a view does not use are dimmed but stay editable, and the bar collapses to a one-line summary. Parameters (not file paths) persist across sessions. The kernel pill shows what the running kernel was loaded with; if k, threads, or read length are changed afterwards it turns amber, because Interactive and Batch QC keep using the loaded index until the kernel is restarted. A result becomes stale when the inputs it depends on change after it ran, and its panel says so.

Each view keeps only its own options: cross-link threshold `m`, filter threshold and output mode, and whether the Report includes the reads.

#### Primer trimming

**Primer trim** has separate **front** and **back** lengths (default **18 bp** each, persisted across sessions), linked by default so they stay equal. The configured number of bases is removed from each end of every reference strand before it is scored, so adapter/primer regions do not distort coverage or path-completeness. Strands shorter than `k` after trimming are reported as skipped. Batch QC accepts different front and back values. `dstoreqc links`, `filter`, and `report` take a single symmetric `-p`, so those views ask you to link the two values (or set them equal) before running.

The Settings workspace is organized into four tabs:

| Tab | Purpose |
|:---|:---|
| Providers | Enable providers, configure API keys and base URLs, and refresh the available model catalog for each provider. |
| Model Selection | Choose the active agent-panel provider, assign one model per enabled provider, and tune temperature and maximum tokens. |
| Appearance | Switch between Light, Dark, and System styles. |
| Diagnostics | Configure diagnostics graph display behavior. |

The agent panel can route diagnostics through these provider definitions:

| Provider | API shape | Default base URL |
|:---|:---|:---|
| OpenAI | Responses API | `https://api.openai.com/v1` |
| Google | Gemini API | `https://generativelanguage.googleapis.com/v1beta` |
| Anthropic | Messages API | `https://api.anthropic.com/v1` |
| GLM | OpenAI-compatible chat completions | `https://open.bigmodel.cn/api/paas/v4` |
| Kimi | OpenAI-compatible chat completions | `https://api.moonshot.cn/v1` |
| DeepSeek | OpenAI-compatible chat completions | `https://api.deepseek.com/v1` |
| MiniMax Local | OpenAI-compatible chat completions | `https://api.minimax.chat/v1` |
| MiniMax Global | OpenAI-compatible chat completions | `https://api.minimaxi.chat/v1` |
| SiliconFlow | OpenAI-compatible chat completions | `https://api.siliconflow.cn/v1` |
| OpenRouter | OpenAI-compatible chat completions | `https://openrouter.ai/api/v1` |
| Local | OpenAI-compatible chat completions | `http://localhost:11434/v1` |
| Custom Endpoint | OpenAI-compatible chat completions | `http://localhost:8000/v1` |

Model refresh uses each provider's model-list endpoint where available: OpenAI-compatible providers use `GET /models`, Anthropic uses `GET /models`, and Google uses `GET /models?key=...`. Provider enablement, model assignments, base URLs, temperature, token limits, and appearance settings are stored in local app storage. API keys are stored separately by the main process using Electron `safeStorage` when encryption is available, with a plaintext fallback when unavailable; credential storage is not universally encrypted. Keys are not written to local app storage.

#### Agent panel

The assistant lives in a resizable panel on the right of every view (drag its left edge, double-click to reset, **⌘J** to hide it to a rail, the widen button for a wide layout).

| Feature | Behavior |
|:---|:---|
| Conversations | Each question starts or continues a saved conversation. The history drawer lists, searches, switches, and deletes conversations (**⌘⇧O** starts a new one). Up to 30 conversations of 200 messages are kept in local app storage; a pre-thread transcript is migrated into one conversation. |
| Chat / Agent modes | **Chat** streams a text answer grounded in the attached context. **Agent** lets the model run the bounded read-only tools below. The readiness pill shows whether a read index and Batch QC cache are loaded; click it to see which tools can currently return evidence and why the others cannot. |
| Context tray | The composer shows the context attached to the next message (the active view's latest result). Click the chip to detach it, pin it to keep it while switching views, or preview the exact JSON payload. |
| Evidence timeline | Agent answers show each tool call as a step with its arguments in plain terms, duration, key facts, a coverage sparkline for profile slices, and the raw evidence on request. A run bar shows the current step, model turn, tool budget, and deadline. |
| Jump to data | Timeline steps link to the Batch QC row they measured (opening its coverage profile) or to Interactive for a queried k-mer. Pure-DNA code spans in answers open in Interactive as a k-mer or sequence-path query. These targets come from tool arguments and results, not from the model's prose. |
| Commands | Type `/` for commands: `/triage`, `/summary` (agent), `/explain`, `/next`, `/metrics`, `/methods` (chat), and `/agent`, `/chat`, `/new`, `/export`. Text after a command is appended as extra focus. Suggested follow-ups adapt to the loaded index, batch, and active view. |
| Message actions | Copy any message, edit and resend an earlier question (later messages are replaced), regenerate the latest answer, and export an agent answer's full evidence record as JSON. Conversations export to Markdown with each agent answer's evidence steps. |

Saved conversations keep each agent answer's compact step summary (tool, arguments, status, duration, facts) but not evidence payloads; those stay in memory for the session and in the explicit JSON export.

#### Bounded read-only AI agent

The panel defaults to ordinary streaming text chat. **Agent** mode opts each request into native function calling through the selected provider. The model can select an allowlisted query, receive deterministic evidence, and continue to an answer or another bounded query. Models/endpoints must support their provider's function-calling protocol; unsupported or malformed responses fail explicitly rather than being interpreted as executable text.

| Tool | Available evidence |
|:---|:---|
| `get_analysis_summary` | Loaded-index counts and effective counting settings, plus cached batch aggregates |
| `get_sequence_profile` | Positional coverage for a cached zero-based batch record index or the user-selected Interactive sequence; declared pagination |
| `query_kmer` | Count and membership-derived neighborhood of one k-mer matching the loaded k |
| `get_batch_rows` | Paginated complete-library or anomaly/status selections from the completed main-process batch cache |
| `find_batch_records` | Exact strand names, such as entangled strands from a report, resolved to their rows in the completed main-process batch cache |
| `get_decodability` | The Decoder readiness result: decodable strands, failure counts by reason, ratio hotspots, and per-strand rows, either one strand's failure and position by exact name or paginated rows selected by failure |
| `evaluate_decoder_settings` | Predicted decodable strands for up to 12 decoder settings on the loaded index, without decoding. Models are told to keep the extra step on, the application's default, unless the user asks otherwise |

The main process validates exact argument fields, integer ranges, DNA strings, and dataset/batch versions before execution and after asynchronous work. The model cannot supply paths, shell commands, new read files, trimming parameters, or exports. Loading, recounting, filtering, changing parameters, and saving files remain user-operated controls, not approval-gated model tools.

Per request, limits are six tool calls, five model turns, 240 seconds (tools stop being offered after 120), 4,096 output tokens per model turn, 4,096 bases per cached profile, 128 coverage positions per page, 25 batch or decoder rows per page, and neighborhood depth two. History, initial context, and each tool result have respective 48,000-, 12,000-, and 24,000-UTF-16-unit budgets. Provider requests have a separate 256,000-unit serialized-body cap and 1-MiB response cap. These are application limits, not a guarantee of low total RAM: the full read index remains unchanged.

The cache holds at most 250,000 batch rows and 40 million eligible sequence bases. Profiles outside those limits require manual selection. Each turn records snapshot/version identifiers, supplied context and omissions, effective model settings, tool arguments/results, timestamps, and completion status. Eight recent records are retained per window for budgeted follow-up context; this is not a durable research archive. Expand the evidence timeline to inspect it and use the message's evidence export for an explicit JSON record. Export records omit API keys and retain only the endpoint origin, not a full URL or provider-private reasoning continuation.

Stop cancels provider work and subsequent agent dispatch. A query already written to the C kernel is drained without adopting its result or shifting FIFO attribution; it does not interrupt C computation. A query timeout or uncertain write stops that kernel session and rejects all queued requests. Restarting, stopping, adding reads, or replacing the batch snapshot invalidates active agent requests. Report interpretation remains a separate text-only request, now bound to its originating report and canceled when a new report starts.

Native Responses, compatible Chat Completions, Anthropic Messages, and Gemini protocol adapters are tested with deterministic fixtures. Those tests do not establish live model availability, factual interpretation quality, prompt-injection resistance, privacy guarantees, or user benefit. Sending a request to a remote endpoint can transmit questions, selected context, k-mer strings, reference identifiers, retrieved measurements, and budgeted earlier evidence. A provider called Local is local only when its actual configured endpoint is local.

```bash
cd desktop
npm install
npm run build
npm run dev
```

To produce a distributable bundle (which packages the prebuilt analyzer binary as an app resource), build the analyzer at the repo root first, then run `electron-builder`:

```bash
make dstoreqc      # from the repo root
cd desktop
npm install
npm run dist             # outputs to desktop/release/
```

---

### Links

Analyzes DNA strands in a FASTA dataset to find and count cross-links. A cross-link is defined as a k-mer shared by different strands, indicating sequence overlap or entanglement.

#### Usage
```bash
dstoreqc links [options] <in.fa>
```

#### Options
| Option | Argument | Description | Default |
|:---|:---|:---|:---|
| `-k` | `INT` | k-mer size | `31` |
| `-m` | `INT` | Only count k-mers occurring in more than this many strands | `1` |
| `-p` | `INT` | Primer bases ignored at each end | `0` |

> [!NOTE]
> It is recommended to remove primers from the sequences before counting cross-links to prevent false positives from shared primer regions.

---

### Filter

A primer-aware filter tool designed to screen out entangled strands from DNA datasets. It identifies and filters out strands that exceed a specified cross-link (shared k-mer) threshold, improving the quality of the sequence pool.

#### Features
- **Primer-Aware**: Automatically ignores primer regions of a specified length at both ends of the strands during k-mer analysis.
- **Configurable Thresholds**: Define maximum tolerable cross-links.
- **Flexible Output**: Option to output either the passed sequences (for downstream assembly) or the filtered sequences (for diagnostics).

#### Usage
```bash
dstoreqc filter [options] <in.fa>
```

#### Options
| Option | Argument | Description | Default |
|:---|:---|:---|:---|
| `-k` | `INT` | k-mer size for entanglement analysis | `31` |
| `-m` | `INT` | Maximum allowed cross-links per strand | `0` |
| `-p` | `INT` | Length of primers to ignore at both ends | `18` |
| `-s` | `None` | Output the names of filtered (entangled) strands instead of the passed FASTA | *(Default: emit passed FASTA)* |

---

## Development & Testing

The repository ships a test suite covering the shared k-mer core (C unit tests)
and the unified CLI end-to-end (Python tests driving
the compiled executable, including the interactive kernel, combined reports,
JSON/Markdown/HTML reports, counter separation, primer trimming, and output-file handling).

```bash
make test          # builds with -Wall -Wextra -Werror, runs unit + e2e tests
./tests/run.sh     # same thing, invoked directly
```

Small deterministic FASTA fixtures live in [`tests/data/`](tests/data) and double as runnable examples. Continuous integration ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) builds the tools (warnings as errors), runs the suite, repeats the end-to-end tests under AddressSanitizer, and type-checks and bundles the desktop app on every push and pull request.

---

## License

This project is licensed under the terms described in the [LICENSE](LICENSE) file.

## Author

**Lifu Song** (lifu.song@outlook.com)
