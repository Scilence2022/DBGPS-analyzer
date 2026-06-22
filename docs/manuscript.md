# DBGPS Analyzer: a high-performance graphical toolkit for k-mer graph-based quality control in DNA data storage

**Authors:** [Author 1], [Author 2], [Author 3]  
**Affiliations:** [Institution 1], [Institution 2]  
**Correspondence:** [email@example.com]

## Abstract

DNA data storage experiments require rapid quality control of sequencing reads, designed oligonucleotide pools, and graph-level failure modes such as dropout, coverage imbalance, and sequence entanglement. We present **DBGPS Analyzer**, an open-source toolkit for De Bruijn graph-based diagnostics in DNA information storage workflows. The software combines a high-performance C backend with an Electron graphical user interface (GUI), enabling both batch-scale computation and interactive inspection without requiring users to write custom scripts. DBGPS Analyzer computes strand recovery (`Sm`), k-mer dropout (`Kd`), and k-mer noise (`Kn`); counts inter-strand cross-links that indicate sequence entanglement; filters problematic strands; and visualizes k-mer coverage and local De Bruijn graph neighborhoods. The interactive kernel builds a sequencing k-mer table once and reuses it for individual k-mer, decoded-index, sequence-path, and per-strand batch queries. The GUI exposes these capabilities through Interactive, Batch QC, Cross-links, Seq-Filter, and Report views, and supports incremental addition of new NGS files to the running kernel so users can continue counting on the existing coverage table. DBGPS Analyzer is designed for fast local analysis through multithreaded k-mer counting, compact hash-based coverage storage, and bounded inter-process communication. Together, the command-line tools and GUI provide an integrated environment for diagnosing sequencing quality and library design issues in DNA data storage studies.

**Keywords:** DNA data storage; De Bruijn graph; k-mer; sequencing quality control; graphical user interface; strand dropout; sequence entanglement

## 1. Introduction

DNA has emerged as a dense and durable medium for archival information storage, with demonstrations spanning small encoded messages through large-scale random-access libraries. Practical DNA storage pipelines, however, remain constrained by errors and biases introduced during synthesis, amplification, sequencing, and decoding. These effects appear as uneven read coverage, missing strands, k-mer dropout, noisy k-mers, and chimeric or entangled sequence patterns. Efficient diagnostic software is therefore needed not only after a full decoding attempt, but also during library design, sequencing quality assessment, and experimental troubleshooting.

Existing analysis workflows often combine ad hoc scripts, command-line k-mer counters, and downstream spreadsheets. This fragmentation can make it difficult to answer operational questions quickly: Which designed strands are fully covered? Which positions within a strand are missing? Are primer-trimmed references entangled through shared k-mers? How do different coverage thresholds affect strand recovery and noise estimates? These questions are especially important for DBGPS-style De Bruijn graph-based DNA storage systems, where local k-mer connectivity and coverage directly influence path recovery.

We developed **DBGPS Analyzer** to provide a fast and accessible quality-control environment for DNA information storage data. The toolkit includes three C command-line programs: `DBGPS-analyzer` for coverage, dropout, noise, and interactive graph diagnostics; `DBGPS-links` for cross-link counting between reference strands; and `DBGPS-seq-filter` for primer-aware filtering of entangled strands. These tools are exposed through a desktop GUI that supports interactive graph queries, whole-reference Batch QC, cross-link analysis, entanglement filtering, and combined report generation. The software is intended for both computational users who need scriptable command-line tools and experimental users who benefit from visual diagnostics.

## 2. Design goals

DBGPS Analyzer was designed around four requirements.

First, the core computations must be fast enough for repeated use during experimental analysis. The backend is implemented in C, uses multithreaded k-mer counting, and stores coverage in a compact saturating-count hash table shared across the analyzer, link counter, and filter tools.

Second, diagnostics must preserve graph context. Instead of reporting only aggregate metrics, the interactive kernel returns coverage for queried k-mers, upstream and downstream De Bruijn graph neighbors, multi-step branch trees, complete sequence coverage profiles, and adjacent coverage fold-change ratios.

Third, the interface must support both large batches and individual inspection. The Batch QC view scores every reference strand against a loaded sequencing k-mer table, while the detail view lets users inspect a single strand's coverage profile and path completeness.

Fourth, the workflow should be usable without scripting. The Electron GUI wraps the C tools, handles FASTA and tab-delimited reference inputs, persists primer and visualization settings, and exports CSV, Markdown, and HTML summaries.

## 3. Software architecture

DBGPS Analyzer has a layered architecture (Figure 1). The C backend performs all k-mer counting and sequence scoring. An Electron main process manages tool execution, file conversion, inter-process communication, and report assembly. The renderer provides the GUI and interactive visualizations.

**Figure 1. Suggested architecture diagram.**  
Create a schematic with three layers: C backend (`DBGPS-analyzer`, `DBGPS-links`, `DBGPS-seq-filter`, `dbgps_core.h`), Electron bridge (main process, preload API, file parsing/conversion, JSON Lines protocol), and GUI views (Interactive, Batch QC, Cross-links, Seq-Filter, Report, Settings).

The shared `dbgps_core.h` module centralizes nucleotide encoding, canonical k-mer handling, invertible hashing, and the sharded saturating-count hash set. This shared core reduces divergence between the analyzer, link counter, and sequence filter, and allows the same k-mer representation to support multiple diagnostic tasks.

### 3.1 Command-line tools

`DBGPS-analyzer` compares designed or target strands against one or more NGS files. In batch mode, it reports a grid of strand recovery, dropout, and noise metrics across coverage and coverage-ratio thresholds. When an output prefix is provided, it also writes detailed per-strand coverage and ratio files. In interactive mode, it starts a JSON Lines kernel that builds the sequencing k-mer table once, then accepts commands such as `summary`, `kmer`, `index`, `sequence`, `sequenceSummary`, `batch`, and `addFile`.

`DBGPS-links` counts cross-links, defined as k-mers shared across different reference strands. Because each strand's k-mers are deduplicated before insertion, the stored count for a k-mer corresponds to the number of distinct strands in which it appears. This enables efficient detection of repeated or entangled sequence regions.

`DBGPS-seq-filter` performs primer-aware filtering of reference strands. It removes or reports strands whose internal k-mers exceed a configurable cross-link threshold, allowing users to prepare cleaner reference sets for downstream analysis.

### 3.2 Graphical user interface

The desktop GUI exposes five main views.

The **Interactive** view starts the JSON Lines kernel, loads NGS sequencing files, displays global k-mer table statistics, and runs k-mer, decimal-index, and sequence-path queries. It also allows additional NGS files to be added to the running kernel; the backend continues counting into the existing k-mer table and returns updated summary metrics.

The **Batch QC** view loads a reference file and scores every strand against the already loaded sequencing table. It reports observed k-mers, total k-mers, path completeness, minimum coverage, mean coverage, and maximum coverage. Users can expand or collapse each read's detailed profile, inspect coverage by k-mer position, toggle coverage and fold-change series, and export the table as CSV.

The **Cross-links** view runs cross-link analysis on a reference file and reports the number of k-mers shared across strands after primer trimming.

The **Seq-Filter** view screens out entangled strands and emits either passed FASTA records or names of filtered strands.

The **Report** view runs the available tools together to generate a combined diagnostics report, including headline metrics, rule-based verdicts, coverage tables, cross-link summaries, entanglement results, optional AI-assisted interpretation, and export to HTML or Markdown.

### 3.3 Input formats and preprocessing

The GUI accepts standard FASTA inputs and tab-delimited index tables containing `Head-Index` and `DNA` columns. Tab-delimited files are converted to temporary FASTA files before command-line execution. Primer handling is configurable: Batch QC supports independent front and back primer trimming, while Seq-Filter and the Report view use a symmetric primer length. Primer trimming prevents shared primer sequences from inflating cross-link counts or distorting coverage diagnostics.

## 4. Metrics

DBGPS Analyzer reports three primary sequencing quality metrics.

**Strand recovery (`Sm`)** is the fraction of target strands that are considered fully covered under a given coverage threshold and coverage-ratio criterion:

```text
Sm = recovered_strands / total_target_strands
```

**k-mer dropout (`Kd`)** is the fraction of expected target k-mers that are absent or below the selected coverage threshold:

```text
Kd = lost_target_kmers / total_target_kmers
```

**k-mer noise (`Kn`)** is the ratio of non-target observed k-mers to retained expected k-mers:

```text
Kn = noise_kmers / existing_target_kmers
```

The software also reports local sequence metrics for each queried or batched strand: observed k-mers, missing k-mers, path completeness, minimum coverage, maximum coverage, mean coverage, and maximum adjacent coverage ratio. These measurements help distinguish uniform low coverage from local dropout, abrupt coverage discontinuities, and graph branching effects.

## 5. Implementation

The backend is written in C and uses zlib-compatible FASTA/FASTQ parsing, POSIX threads, and a multistage k-mer counting pipeline. Reads are optionally truncated to a configured maximum read length before counting. Canonical k-mers are inserted into a saturating-count hash table, allowing rapid coverage lookup during downstream analysis. The interactive kernel keeps this hash table resident, avoiding repeated counting when users run multiple queries or Batch QC operations.

The GUI is implemented with Electron and TypeScript. The main process launches the C tools, converts tabular inputs when needed, manages the interactive kernel, and exposes a typed preload API to the renderer. The renderer is responsible for state management, charts, tables, controls, and report presentation. Long Batch QC runs are summarized compactly to avoid sending full per-position arrays for every strand; detailed profiles are loaded only when a user expands a specific strand.

The incremental NGS-file workflow extends the interactive kernel with an `addFile` command. The command calls the same incremental counting routine used when multiple NGS files are supplied at startup, appends the new file to the kernel's loaded-file list, and emits an updated summary containing k, read-length limit, distinct k-mer count, total saturated coverage, and all loaded files. In the GUI, the `Add sequencing files` control sends selected files sequentially through the kernel queue, then refreshes the displayed file list and summary cards.

## 6. Validation and testing

The repository includes C unit tests for the shared k-mer core and Python end-to-end tests for the command-line tools. The tests cover hash round-tripping, reverse-complement encoding, canonical k-mer handling, k-mer insertion and lookup, interactive kernel queries, validation failures, Batch QC summaries, Sm/Kd/Kn output, cross-link counting, and sequence filtering.

For manuscript submission, we recommend adding a benchmark dataset and reporting the following measurements:

| Dataset | NGS reads | Reference strands | k | Threads | Task | Runtime | Peak memory |
|:---|---:|---:|---:|---:|:---|---:|---:|
| [Dataset A] | [n] | [n] | 31 | [t] | Initial NGS counting | [time] | [GB] |
| [Dataset A] | [n] | [n] | 31 | [t] | Add one NGS file incrementally | [time] | [GB] |
| [Dataset A] | [n] | [n] | 31 | [t] | Batch QC, all strands | [time] | [GB] |
| [Dataset A] | [n] | [n] | 31 | [t] | Cross-link counting | [time] | [GB] |
| [Dataset A] | [n] | [n] | 31 | [t] | Seq-Filter | [time] | [GB] |

**Recommended benchmark protocol.** Run each task three times on the same workstation, report mean and standard deviation, and include CPU model, RAM, operating system, compiler version, and storage type. If claiming superiority over another tool or script, compare against the exact version and command used, and publish the benchmark inputs or a reproducible generator.

## 7. Example workflow

A typical GUI workflow begins in the Interactive view. Users select one or more NGS files, choose k, thread count, and read-length limit, then start the kernel. The summary cards show the number of distinct k-mers, total coverage, k, and loaded file count. If additional sequencing files become available, users can add them without restarting; the kernel continues counting into the current table and updates the summary.

Next, the user can inspect specific k-mers or full reference sequences. K-mer queries reveal upstream and downstream graph neighbors, while sequence queries show coverage across ordered k-mer positions. The same kernel can then be reused in Batch QC to score every reference strand. Low-coverage, missing, or path-broken strands can be expanded individually to inspect their detailed profiles. Finally, Cross-links, Seq-Filter, and Report views summarize library entanglement and export a report for downstream documentation.

## 8. Discussion

DBGPS Analyzer fills a practical gap between low-level k-mer computation and experimental interpretation in DNA data storage studies. Its main advantage is integration: the same local k-mer table supports aggregate metrics, interactive De Bruijn graph queries, whole-library Batch QC, and report generation. The GUI lowers the barrier for experimental users, while the command-line tools remain suitable for scripted pipelines and reproducible analyses.

The tool is designed for high-speed local execution, but performance claims should be interpreted in the context of dataset size, k, read length, thread count, and hardware. Future releases could add automated benchmark reporting, direct support for additional sequencing formats, richer comparative plots across sequencing runs, and tighter integration with DBGPS encoding and decoding workflows.

## 9. Availability

DBGPS Analyzer is available as open-source software at:

```text
https://github.com/Scilence2022/DBGPS-analyzer
```

The repository includes source code for the command-line tools and Electron GUI, deterministic test fixtures, C unit tests, Python end-to-end tests, and build instructions. The software is distributed under the license provided in the repository.

## 10. Data availability

No new biological dataset is required to run the software. Small deterministic FASTA fixtures used for testing are included in the repository. Benchmark datasets used for publication should be deposited in a public repository or accompanied by a reproducible data-generation script.

## 11. Author contributions

[Author 1] conceived the study and implemented the DBGPS Analyzer backend. [Author 2] developed the GUI and reporting workflow. [Author 3] designed validation experiments and benchmarks. All authors wrote and approved the manuscript.

## 12. Competing interests

The authors declare no competing interests. [Revise if needed.]

## References

1. Church GM, Gao Y, Kosuri S. Next-generation digital information storage in DNA. *Science*. 2012;337(6102):1628. doi:10.1126/science.1226355.
2. Goldman N, Bertone P, Chen S, Dessimoz C, LeProust EM, Sipos B, Birney E. Towards practical, high-capacity, low-maintenance information storage in synthesized DNA. *Nature*. 2013;494:77-80. doi:10.1038/nature11875.
3. Grass RN, Heckel R, Puddu M, Paunescu D, Stark WJ. Robust chemical preservation of digital information on DNA in silica with error-correcting codes. *Angewandte Chemie International Edition*. 2015;54(8):2552-2555. doi:10.1002/anie.201411378.
4. Erlich Y, Zielinski D. DNA Fountain enables a robust and efficient storage architecture. *Science*. 2017;355(6328):950-954. doi:10.1126/science.aaj2038.
5. Organick L, Ang SD, Chen YJ, Lopez R, Yekhanin S, Makarychev K, Racz MZ, Kamath G, Gopalan P, Nguyen B, Takahashi CN, Newman S, Parker HY, Rashtchian C, Stewart K, Gupta G, Carlson R, Mulligan J, Carmean DM, Seelig G, Ceze L, Strauss K. Random access in large-scale DNA data storage. *Nature Biotechnology*. 2018;36:242-248. doi:10.1038/nbt.4079.

## Notes Before Submission

- Replace all bracketed author, affiliation, benchmark, and dataset placeholders.
- Add a real performance table before making quantitative speed claims.
- Add screenshots of the GUI views as figure panels.
- Confirm journal formatting requirements for section names, abstract length, reference style, and data/code availability statements.
