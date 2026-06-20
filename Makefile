CFLAGS=-g -Wall -O3
CXXFLAGS=$(CFLAGS) -std=c++11
LIBS=-lz
PROG=DBGPS-analyzer DBGPS-links DBGPS-seq-filter
CORE=dbgps_core.h khashl.h ketopt.h kseq.h kthread.h

ifneq ($(asan),)
	CFLAGS+=-fsanitize=address
	LIBS+=-fsanitize=address
endif

.PHONY:all clean version test

all:$(PROG)

# DBGPS-analyzer: Analyzer tool for calculating Sm, Kn, Kd values
DBGPS-analyzer:DBGPS-analyzer.c $(CORE)
	$(CC) $(CFLAGS) -o $@ DBGPS-analyzer.c kthread.c $(LIBS) -lpthread

# DBGPS-links: count cross-links (k-mers shared between strands)
DBGPS-links:DBGPS-links.c $(CORE)
	$(CC) $(CFLAGS) -o $@ DBGPS-links.c kthread.c $(LIBS) -lpthread

# DBGPS-seq-filter: filter to screen out entangled strands (a.k.a. DBGPS-ft)
DBGPS-seq-filter:DBGPS-seq-filter.c $(CORE)
	$(CC) $(CFLAGS) -o $@ DBGPS-seq-filter.c kthread.c $(LIBS) -lpthread

# Build the tools and run the unit + end-to-end test suite.
test:
	./tests/run.sh

clean:
	rm -fr *.dSYM $(PROG) tests/unit_core tests/unit_core.dSYM

# Build a specific version: make VERSION=DBGPS-analyzer
VERSION?=all
version:
	$(MAKE) $(VERSION)
