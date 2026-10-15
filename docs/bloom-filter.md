# Optional Bloom reference index

`DBGPS-analyzer` defaults to its full read-derived k-mer index. `--bloom`
selects a reference-restricted index: exact canonical reference keys and their
14-bit saturating read counts, preceded by a blocked Bloom filter. It reduces
the number of stored keys, not the precision of target counts.

## Backend selection

The following GitHub implementations were inspected for this integration:

| Repository | Relevant properties | Fit for DBGPS |
| --- | --- | --- |
| [lh3/bfc](https://github.com/lh3/bfc) | MIT; small C blocked filter; accepts a precomputed `uint64_t` hash; 64-byte blocks | Selected: matches the packed k-mer pipeline and requires no hash-string conversion, new build system, or SIMD target flags |
| [jvirkki/libbloom](https://github.com/jvirkki/libbloom) | BSD-2-Clause; small conventional C filter; binary-buffer API; MurmurHash2 and probability-based sizing | Good general library; inspected version requires 64-bit `unsigned long` and hashes each buffer twice with 32-bit MurmurHash2 |
| [barrust/bloom](https://github.com/barrust/bloom) | MIT; C; string and precomputed-hash APIs; serialization and mmap support | More functionality than needed; default string API allocates a hash array per operation, while the alternate API requires supplying multiple hashes |
| [jbapple/libfilter](https://github.com/jbapple/libfilter) | Apache-2.0 block filter; 64-bit hash API; scalar, AVX2 and NEON paths | Strong future comparison; more memory/build/platform code than the selected two-file scalar core |

This is an integration assessment, not a measured speed ranking between the
libraries. The current codebase already uses lightweight C components from the
same k-mer tooling ecosystem. The selected backend keeps that style and works
without `-march=native` on both supported macOS and Linux builds.

`vendor/bfc/bbf.{c,h}` derives from commit
[`69ab176e7aac4af482d7d8587e45bfe239d02c96`](https://github.com/lh3/bfc/tree/69ab176e7aac4af482d7d8587e45bfe239d02c96).
The upstream MIT notice is retained in `vendor/bfc/LICENSE.txt`. Local changes
validate shift/hash counts and allocation results, use `memset`, remove the
unused occupancy function, and make query pointers const. The block mapping,
double hashing, reserved lock byte and insertion locking follow upstream.

## Command line

Standalone Sm/Kd evaluation uses the positional reference:

```sh
./DBGPS-analyzer --bloom --bloom-bits 16 -k 31 -t 16 reference.fa reads.fq.gz
```

The JSON Lines kernel needs its reference before reading sequencing files:

```sh
./DBGPS-analyzer -i --bloom --bloom-reference reference.fa -k 31 reads.fq.gz
```

`--bloom` is off by default. `--bloom-bits` accepts integers 4 through 64 and
defaults to 16. It requests a minimum number of allocated bits per distinct
target key; allocation rounds up to a power of two, with a minimum 64-byte
block. Six probes are used per operation. This is a space setting, not a
guaranteed false-positive probability: block occupancy, the reserved lock byte,
and rounding affect the observed rate. False-positive rate affects work, not
the resulting target counts.

`--bloom-reference` is only accepted with `-i --bloom`; standalone mode always
uses the positional strand file so the counted and evaluated target universes
cannot accidentally differ. `--bloom-bits` without `--bloom` is rejected.
References must be FASTA/FASTQ, optionally gzip-compressed. The desktop also
normalizes its existing tab-delimited reference format before starting the
kernel.

## Counting and query contract

1. Extract the complete reference's canonical keys, resetting at non-ACGT
   bases just as the standalone analyzer does. Store each exact key once with
   count zero. All windows are indexed; primer trimming can be applied later
   without changing the index.
2. Construct the Bloom filter from the exact set. Mix the existing invertible
   k-mer hash across all 64 bits before applying the block mapping, including
   for small k where the original masked hash has few significant bits.
3. Test buffered read keys against the completed read-only filter in the
   parallel shard workers. Negative keys are skipped. Each filter-positive key is looked up in the
   exact shard; only members increment their saturating count. False positives
   do not create table entries. No dictionary insertion occurs during counting.
   Only the existing bounded input blocks are buffered, not the whole dataset.
4. Partition counter writes by the existing shards. Bloom reads can overlap
   counting because the filter is no longer modified. The backend does not
   support concurrent insertion and lookup.

For the same reference, k, reads, read-length limit and threshold settings,
target coverage, Sm and Kd retain baseline semantics and the 16,383 count cap.
Standalone `Noise` and `Kn` are `nan`: the global distinct off-target population
is not retained. The standalone target histogram comes from the existing
exact reference table, avoiding a second reference-dedup table.

Kernel behavior in this mode:

- `sequence`, `sequenceSummary` and `batch` return exact target coverage. A
  sequence containing any key outside the indexed set produces an error,
  rather than treating unavailable data as zero coverage. Batch uses an error
  row for that sequence. Keys present in the reference but absent from reads
  remain valid zero-coverage observations.
- `kmer` and `index` graph commands return an explicit scope error. Arbitrary
  off-target branches cannot be reconstructed from a reference-only index.
- `addFile` counts new reads against the same reference set. To index a new
  reference universe, restart the kernel and recount the sequencing files.
- Ready, summary, sequence and batch results carry `indexScope`, reference,
  target-key count, filter size and availability flags. `distinctKmers` and
  `totalKmerCoverage` describe observed reference keys only. These fields are
  not global read-key totals. Counts are aggregated after saturation.

An ordinary Bloom filter used as the sole membership or coverage source would
not meet this contract. Critical-false-positive graph encodings also do not
automatically supply exact weighted coverage or arbitrary key queries.

## Validation and measurement

`make test` includes the blocked-filter unit tests, the existing full-mode
goldens, and full-versus-Bloom regression tests. CI repeats the CLI tests with
AddressSanitizer. Desktop tests cover option validation and scope propagation.

To measure the two kernel modes on the same complete dataset:

```sh
python3 tests/benchmark_bloom.py --reference reference.tab --reads reads.fq.gz \
  --output tmp/bloom-benchmark --threads 16
```

The harness normalizes one reference, runs both modes sequentially with the
same inputs and query, records each kernel's peak RSS and wall time, and
compares SHA-256 digests of every Batch QC row after removing scope metadata.
Its RSS excludes Electron and the Python harness. Results are single-run
measurements; they do not isolate the filter's speed benefit from restricting
the dictionary. A future direct exact-reference mode is the appropriate
additional control for that question.

### Local full-data check, 2026-10-15

On the archived YC10 FASTQ and 210,000-reference library, the current `-O2`
build was measured sequentially on macOS/ARM64 with k=31, 16 threads, read
limit 200, query trimming 18/18 and the default 16-bit Bloom budget:

| Kernel | Wall time (s) | Peak RSS (GiB) | Path-complete records |
| --- | ---: | ---: | ---: |
| Full read index | 30.06 | 10.80 | 209,357 |
| Bloom reference index | 40.33 | 1.98 | 209,357 |

All 210,000 Batch QC rows matched after removing reference-scope metadata,
including coverage summaries and error/status fields. Both normalized row
sets had SHA-256
`ff3c8ab9d6474d6797b11149699e046349106c37bfe47daf7868c173944ee080`.
Peak RSS fell by 81.6% (5.44-fold), while wall time increased by 34.2%.
The reference index contained 35,161,882 distinct full-reference keys, of which
35,123,373 were observed; the rounded filter allocation was 128 MiB. The full
index contained 713,687,359 observed read keys. Full-reference indexing includes
primer-region windows, so its target universe is larger than the internal-region
upper bound used in earlier design estimates.

These are one paired run, including reference-index construction and Batch QC;
they measure the RAM/time tradeoff of the complete optional mode. They are not
a repeated-trial performance estimate or a comparison of Bloom libraries. Raw
logs and row digests are in `tmp/bloom-yc10-parallel/comparison.json` in the
development worktree; generated measurements are not required to build the code.

Local normal builds, desktop tests, the real Electron/C-kernel workflow and
UBSan CLI checks passed. The host's AddressSanitizer runtime deadlocked before
`main` during its dyld/shadow-memory initialization; no local ASan pass is
claimed. The Linux CI workflow includes both CLI suites under ASan.
