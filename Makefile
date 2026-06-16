CFLAGS=-g -Wall -O3
CXXFLAGS=$(CFLAGS) -std=c++11
LIBS=-lz
PROG=DBGPS-analyzer DBGPS-links DBGPS2 DBGPS-seq-filter

ifneq ($(asan),)
	CFLAGS+=-fsanitize=address
	LIBS+=-fsanitize=address
endif

.PHONY:all clean version

all:$(PROG)

# DBGPS-analyzer: Analyzer tool for calculating Sm, Kn, Kd values
# Recent updates: 
# - Added -o option to specify output_prefix for log files
# - Added -R option for coverage ratio range iteration
# - Changed -l to -L for read length
# - Changed -d to -C for max coverage
# - Changed -a to -s for skip ratio parameter
DBGPS-analyzer:DBGPS-analyzer.c khashl.h ketopt.h kseq.h kthread.h
	$(CC) $(CFLAGS) -o $@ DBGPS-analyzer.c kthread.c $(LIBS) -lpthread

DBGPS-links:DBGPS-links.c khashl.h ketopt.h kseq.h kthread.h
	$(CC) $(CFLAGS) -o $@ DBGPS-links.c kthread.c $(LIBS) -lpthread

# DBGPS2: Read-Length constrained version with dynamic coverage ratio support
# Previously DBGPS-dy2-rl
# Features:
# - Skip option for initial ratio checks
# - Output prefix option for log and strands files
# - Ratio range iteration support
# - Improved path finding algorithm
DBGPS2:DBGPS2.c khashl.h ketopt.h kseq.h kthread.h
	$(CC) $(CFLAGS) -o $@ DBGPS2.c kthread.c $(LIBS) -lpthread

# DBGPS-seq-filter: Filter to screen out entangled strands
# Also known as DBGPS-ft
DBGPS-seq-filter:DBGPS-seq-filter.c khashl.h ketopt.h kseq.h kthread.h
	$(CC) $(CFLAGS) -o $@ DBGPS-seq-filter.c kthread.c $(LIBS) -lpthread

clean:
	rm -fr *.dSYM $(PROG)

# Build a specific version: make VERSION=DBGPS2
VERSION?=all
version:
	$(MAKE) $(VERSION)
