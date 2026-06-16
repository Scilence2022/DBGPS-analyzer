# DBGPS2

DBGPS2 is a collection of tools for DNA data storage analysis and processing, with a focus on sequence assembly, cross-link detection, and coverage analysis.

## Overview

This project provides software tools for analyzing and reconstructing DNA sequences from data storage systems. The main components are:

- **DBGPS2**: A read-length constrained sequence assembler with dynamic coverage ratio support (formerly DBGPS-dy2-rl)
- **DBGPS-analyzer**: Tool for calculating key sequencing metrics (Sm, Kn, Kd values)
- **DBGPS-links**: Analyzer for detecting cross-links between DNA strands
- **DBGPS-seq-filter**: Filter to screen out entangled strands (also known as DBGPS-ft)

## Installation

### Prerequisites

- GCC compiler
- zlib development libraries

### Building the software

Clone this repository and build using make:

```
git clone https://github.com/your-username/DBGPS2.git
cd DBGPS2
make
```

To build individual components:

```
make DBGPS2
make DBGPS-analyzer
make DBGPS-links
make DBGPS-seq-filter
```

## Tool Descriptions

### DBGPS2

A read-length constrained sequence assembler with dynamic coverage ratio handling.

#### Features
- Skip option for skipping initial ratio checks at specified positions
- Output prefix option for log and strands files
- Ratio range iteration support
- Improved path finding algorithm

#### Usage
```
DBGPS2 [options] <input file>
                  [Supporting formats: *fq, *fa, *fq.gz, *fa.gz]

Options:
  -k INT     k-mer size
  -i INT     length of index
  -l INT     data encoding length
  -t INT     number of threads
  -c INT     k-mer coverage cut-off for exclusion of noise k-mers
  -C INT     Switch on k-mer coverage testing mode
  -a INT     Initial index
  -b INT     End index
  -r FLOAT   Maximum coverage ratio
  -R FLOAT   Upper bound for ratio range iteration (0 = disabled)
  -s INT     Number of initial positions to skip ratio checks for
  -o STR     Output prefix for log file and strands file
```

### DBGPS-analyzer

Analyzer tool for calculating sequencing metrics like Sm, Kn, and Kd values.

#### Features
- Output prefix specification for log files
- Coverage ratio range iteration
- Parametrized read length and max coverage settings

#### Usage
```
DBGPS-analyzer [options] <Strand seq file> <NGS files>
                         [Supporting formats: *fq, *fa, *fq.gz, *fa.gz]

Options:
  -k INT     k-mer size
  -t INT     number of threads
  -L INT     Maximal read length for k-mer counting
  -r FLOAT   Maximum coverage ratio (0 = no limitation)
  -R FLOAT   Upper bound for ratio range iteration
  -c INT     Minimum coverage cutoff
  -C INT     Maximum coverage cutoff
  -s INT     Number of initial ratio values to skip
  -o STR     Output prefix for additional files
```

### DBGPS-links

Analyzer for detecting cross-links between DNA strands in a dataset.

#### Usage
```
DBGPS-links [options] <in.fa>

Options:
  -k INT     k-mer size [31]
  -m INT     max link number [1]
```

### DBGPS-seq-filter

Filter tool to screen out entangled strands from DNA data. This tool identifies and removes strands with more than a specified number of cross-links, helping to improve sequence quality.

#### Features
- Primer-aware analysis that excludes primer regions from k-mer analysis
- Configurable k-mer size for entanglement detection
- Option to output either passed or filtered sequences

#### Usage
```
DBGPS-seq-filter [options] <in.fa>

Options:
  -k INT     k-mer size for entangle analysis [31]
  -m INT     Maximal strand cross-links [0]
  -p INT     Length of primers [18]
  -s         Output passed sequences instead of filtered ones
```

## License

This project is licensed under the terms in the LICENSE file.

## Author

Lifu Song (lifu.song@outlook.com)