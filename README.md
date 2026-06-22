# DBGPS-analyzer: DNA Information Storage Data Quality Analyzer

A specialized suite of high-performance tools for **data quality analysis in DNA information storage systems**. This repository provides tools to calculate sequencing metrics, detect inter-strand cross-links, and filter out entangled sequences.

This codebase was split out from the original DBGPS DNA information storage encoding/decoding framework, extracting and optimizing the components specifically designed for quality control, coverage analysis, and data filtering.

---

## Table of Contents
1. [Overview of Tools](#overview-of-tools)
2. [Workflow & Theory](#workflow--theory)
3. [Installation & Building](#installation--building)
4. [Tool Guides & Usage](#tool-guides--usage)
   - [DBGPS-analyzer](#dbgps-analyzer)
   - [DBGPS-links](#dbgps-links)
   - [DBGPS-seq-filter](#dbgps-seq-filter)
5. [License](#license)

---

## Overview of Tools

This project consists of three core C-based command-line utilities:

1. **`DBGPS-analyzer`** (implemented in [DBGPS-analyzer.c](file:///Users/song/Github-Repos/DBGPS-analyzer/DBGPS-analyzer.c)): Evaluates sequencing datasets against expected target strands, calculating critical quality metrics such as strand recovery rate ($S_m$), k-mer noise ratio ($K_n$), and k-mer dropout rate ($K_d$).
2. **`DBGPS-links`** (implemented in [DBGPS-links.c](file:///Users/song/Github-Repos/DBGPS-analyzer/DBGPS-links.c)): Detects and counts cross-links between DNA strands to identify repeated patterns and sequence entanglement.
3. **`DBGPS-seq-filter`** (implemented in [DBGPS-seq-filter.c](file:///Users/song/Github-Repos/DBGPS-analyzer/DBGPS-seq-filter.c)): Screens out and filters entangled or highly cross-linked strands to prepare sequencing data for cleaner assembly.

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
Clone this repository and compile using the [Makefile](file:///Users/song/Github-Repos/DBGPS-analyzer/Makefile):
```bash
git clone https://github.com/Scilence2022/DBGPS-analyzer.git
cd DBGPS-analyzer
make
```

The three tools share their k-mer / hash-table core through [`dbgps_core.h`](file:///Users/song/Github-Repos/DBGPS-analyzer/dbgps_core.h), so the nucleotide tables, invertible hash, k-mer encode/decode, and the saturating-count hash set are defined once.

To compile individual tools:
```bash
make DBGPS-analyzer
make DBGPS-links
make DBGPS-seq-filter
```

---

## Tool Guides & Usage

### DBGPS-analyzer

Computes coverage metrics ($S_m$, $K_n$, $K_d$) by comparing a pool of target/designed strands with NGS sequencing files.

#### Features
- Support for multi-threaded k-mer counting.
- Coverage ratio range iteration and step size control.
- Output prefix options for logs, coverage details, coverage ratios, ratio ranges, and $S_m, K_d, K_n$ values.
- Interactive JSON Lines diagnostics kernel for k-mer coverage, upstream/downstream De Bruijn Graph neighbors, and strand path completeness.

#### Usage
```bash
DBGPS-analyzer [options] <Strand seq file> <NGS files>
DBGPS-analyzer -i [options] <NGS files>
```
*Supported formats: `.fa`, `.fq`, `.fa.gz`, `.fq.gz`*

#### Options
| Option | Argument | Description | Default |
|:---|:---|:---|:---|
| `-i` | `None` | Start interactive JSON Lines diagnostics kernel mode | `Off` |
| `-k` | `INT` | k-mer size | `31` |
| `-t` | `INT` | Number of threads for multi-threading | `3` |
| `-L` | `INT` | Maximum read length for k-mer counting | `200` |
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

Interactive mode builds the sequencing k-mer coverage table from one or more NGS files, then accepts one command per line on stdin and writes one JSON object per line on stdout.

```bash
make DBGPS-analyzer
printf 'summary\nkmer ACGTACGT 2 2\nsequence ACGTACGTACGT\nexit\n' \
  | ./DBGPS-analyzer -i -k 8 reads.fa
```

Supported commands:

| Command | Description |
|:---|:---|
| `summary` | Return k, read-length limit, distinct k-mer count, and total saturated k-mer coverage. |
| `kmer <ACGT...> [upstreamDepth] [downstreamDepth]` | Query one DNA sequence. If the sequence is exactly k bases, it is used directly. If it is longer than k, the leftmost k-mer anchors upstream analysis and the rightmost k-mer anchors downstream analysis. Returns canonical coverage, one-step neighbors, and optional multi-step covered branch trees. Depth values are clamped to 0-6. |
| `index <DECIMAL> <baseLength> [upstreamDepth] [downstreamDepth]` | Convert a decimal index to base-4, decode 0/1/2/3 with the default A/C/G/T scheme, left-pad with A bases when the decoded length is shorter than `baseLength`, then run greedy upstream/downstream path search. If the decoded DNA is still shorter than k, covered k-mers matching that prefix are returned as multiple greedy start k-mers up to the start limit. |
| `sequence <ACGT...>` | Query every ordered k-mer in a DNA strand and return coverage, missing positions, path completeness, and adjacent coverage ratios. |
| `help` | Return supported commands. |
| `exit` | Stop the interactive kernel. |

### Electron Desktop App

The Electron desktop app lives in [`desktop/`](file:///Users/song/Github-Repos/DBGPS-analyzer/desktop). It is organized into five top-level views (plus a Settings workspace), all wired to the C tools through the Electron main process:

| View | Purpose |
|:---|:---|
| **Interactive** | Start/stop the `DBGPS-analyzer` JSON-Lines kernel; run k-mer, index, and sequence-path queries; visualize multi-step upstream/downstream De Bruijn graph trees; chat with the AI diagnostician. |
| **Batch QC** | Load a reference set (FASTA **or** tab-delimited) and automatically score **every** strand against the loaded sequencing k-mer table — one row per strand showing observed/total k-mers, path completeness, and min/mean/max coverage. Front/back primer regions are trimmed first; click any strand to drill into its full coverage profile, and export the whole table as CSV. Reuses the kernel started in the Interactive tab. |
| **Cross-links** | Run `DBGPS-links` on a FASTA and report the total number of k-mers shared across strands (entanglement), with k and minimum-shared-strands controls. |
| **Seq-Filter** | Run `DBGPS-seq-filter` to screen entangled strands; choose k, max cross-links, primer length, and whether to emit passed FASTA or the names of filtered strands; save the output to a file. |
| **Report** | Generate a **comprehensive diagnostics report** over a reference strand set: run all three tools (and `DBGPS-analyzer` batch metrics when NGS reads are supplied), with headline metrics, rule-based verdicts, the Sm/Kd/Kn table, cross-link and entanglement summaries, an optional AI interpretation, and one-click export to HTML or Markdown. |

The combined report runs the three tools concurrently. `DBGPS-links` and `DBGPS-seq-filter` analyze the reference strands (k-mer entanglement of the designed library); `DBGPS-analyzer` additionally computes strand recovery (Sm), k-mer dropout (Kd), and k-mer noise (Kn) when NGS reads are provided.

#### Input formats

Every reference picker in the desktop app accepts two formats and auto-detects which one a file uses:

1. **FASTA** (`>name` headers followed by sequence lines), optionally gzip-compressed.
2. **Tab-delimited** index tables — one record per line as `Head-Index<TAB>DNA`, with an optional header row (e.g. `Head-Index   DNA`) that is skipped automatically:

   ```text
   Head-Index      DNA
   101010102       CCTGCAGAGTAGCATGTCATTGATTCTAGTGC...GACACTGATGCATCCG
   101010104       CCTGCAGAGTAGCATGTCATTGATTCTAGTGC...GACACTGATGCATCCG
   ```

   The first column becomes the strand name and the DNA column its sequence. Because the C tools read FASTA/FASTQ, tab-delimited inputs are converted to a temporary FASTA in the Electron main process before a tool runs.

#### Primer trimming

The Batch QC view exposes separate **front** and **back** primer lengths (default **18 bp** each, persisted across sessions). The configured number of bases is removed from each end of every reference strand before it is scored, so adapter/primer regions do not distort coverage or path-completeness. Strands shorter than `k` after trimming are reported as skipped. (`DBGPS-seq-filter` and the Report view keep their own symmetric primer length `-p`.)

The Settings workspace is organized into four tabs:

| Tab | Purpose |
|:---|:---|
| Providers | Enable providers, configure API keys and base URLs, and refresh the available model catalog for each provider. |
| Model Selection | Choose the active ChatBox provider, assign one model per enabled provider, and tune temperature and maximum tokens. |
| Appearance | Switch between Light, Dark, and System styles. |
| Diagnostics | Configure diagnostics graph display behavior. |

The ChatBox can route diagnostics through these provider definitions:

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

Model refresh uses each provider's model-list endpoint where available: OpenAI-compatible providers use `GET /models`, Anthropic uses `GET /models`, and Google uses `GET /models?key=...`. Provider enablement, model assignments, base URLs, temperature, token limits, and appearance settings are stored in local app storage. **API keys are stored separately, encrypted with the operating-system keychain via Electron `safeStorage`** (handled by the main process), and are never written to local app storage.

```bash
cd desktop
npm install
npm run build
npm run dev
```

To produce a distributable bundle (which packages the prebuilt analyzer binary as an app resource), build the analyzer at the repo root first, then run `electron-builder`:

```bash
make DBGPS-analyzer      # from the repo root
cd desktop
npm install
npm run dist             # outputs to desktop/release/
```

---

### DBGPS-links

Analyzes DNA strands in a FASTA dataset to find and count cross-links. A cross-link is defined as a k-mer shared by different strands, indicating sequence overlap or entanglement.

#### Usage
```bash
DBGPS-links [options] <in.fa>
```

#### Options
| Option | Argument | Description | Default |
|:---|:---|:---|:---|
| `-k` | `INT` | k-mer size | `31` |
| `-m` | `INT` | Only count k-mers occurring in more than this many strands | `1` |

> [!NOTE]
> It is recommended to remove primers from the sequences before counting cross-links to prevent false positives from shared primer regions.

---

### DBGPS-seq-filter

A primer-aware filter tool designed to screen out entangled strands from DNA datasets. It identifies and filters out strands that exceed a specified cross-link (shared k-mer) threshold, improving the quality of the sequence pool.

#### Features
- **Primer-Aware**: Automatically ignores primer regions of a specified length at both ends of the strands during k-mer analysis.
- **Configurable Thresholds**: Define maximum tolerable cross-links.
- **Flexible Output**: Option to output either the passed sequences (for downstream assembly) or the filtered sequences (for diagnostics).

#### Usage
```bash
DBGPS-seq-filter [options] <in.fa>
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
and the three command-line tools end-to-end (Python tests driving the compiled
binaries, including the interactive kernel protocol).

```bash
make test          # builds with -Wall -Wextra -Werror, runs unit + e2e tests
./tests/run.sh     # same thing, invoked directly
```

Small deterministic FASTA fixtures live in [`tests/data/`](file:///Users/song/Github-Repos/DBGPS-analyzer/tests/data) and double as runnable examples. Continuous integration ([`.github/workflows/ci.yml`](file:///Users/song/Github-Repos/DBGPS-analyzer/.github/workflows/ci.yml)) builds the tools (warnings as errors), runs the suite, repeats the end-to-end tests under AddressSanitizer, and type-checks and bundles the desktop app on every push and pull request.

---

## License

This project is licensed under the terms described in the [LICENSE](file:///Users/song/Github-Repos/DBGPS-analyzer/LICENSE) file.

## Author

**Lifu Song** (lifu.song@outlook.com)
