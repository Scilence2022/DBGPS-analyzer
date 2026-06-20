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
git clone https://github.com/your-username/DBGPS-analyzer.git
cd DBGPS-analyzer
make
```

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
| `index <DECIMAL> [upstreamDepth] [downstreamDepth]` | Convert a decimal index to base-4, decode 0/1/2/3 with the default A/C/G/T scheme, then run greedy upstream/downstream path search. If the decoded DNA is shorter than k, covered k-mers matching that prefix are returned as multiple greedy start k-mers up to the start limit. |
| `sequence <ACGT...>` | Query every ordered k-mer in a DNA strand and return coverage, missing positions, path completeness, and adjacent coverage ratios. |
| `help` | Return supported commands. |
| `exit` | Stop the interactive kernel. |

### Electron Desktop App

The Electron desktop app lives in [`desktop/`](file:///Users/song/Github-Repos/DBGPS-analyzer/desktop). It provides file selection, kernel start/stop, k-mer and sequence path query views, multi-step upstream/downstream k-mer tree visualization, a Settings workspace, dark/light/system appearance modes, and a real AI ChatBox wired through the Electron main process.

The Settings workspace is organized into three tabs:

| Tab | Purpose |
|:---|:---|
| Providers | Enable providers, configure API keys and base URLs, and refresh the available model catalog for each provider. |
| Model Selection | Choose the active ChatBox provider, assign one model per enabled provider, and tune temperature and maximum tokens. |
| Appearance | Switch between Light, Dark, and System styles. |

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

Model refresh uses each provider's model-list endpoint where available: OpenAI-compatible providers use `GET /models`, Anthropic uses `GET /models`, and Google uses `GET /models?key=...`. Provider enablement, API keys, model assignments, base URLs, temperature, token limits, and appearance settings are stored in local app storage.

```bash
cd desktop
npm install
npm run build
npm run dev
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
| `-m` | `INT` | Maximum link occurrence threshold to evaluate | `1` |

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
| `-s` | `None` | Output passed sequences (FASTA) instead of names of filtered ones | *(Enabled by default)* |

---

## License

This project is licensed under the terms described in the [LICENSE](file:///Users/song/Github-Repos/DBGPS-analyzer/LICENSE) file.

## Author

**Lifu Song** (lifu.song@outlook.com)
