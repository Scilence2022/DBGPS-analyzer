# -Wextra matches the warning set CI enforces (tests/run.sh adds -Werror), so a
# plain `make` surfaces the same diagnostics locally. -Werror is left to CI so
# downstream toolchains are not blocked by benign warnings.
.DEFAULT_GOAL := all

CFLAGS ?= -g -Wall -Wextra -O3
LDLIBS ?= -lz
THREAD_FLAGS ?= -pthread

PROG := dstoreqc
SOURCES := dstoreqc.c dstoreqc_analyzer.c dstoreqc_reference.c dstoreqc_report.c kthread.c vendor/bfc/bbf.c
BUILD_DIR := .build
OBJECTS := $(SOURCES:%.c=$(BUILD_DIR)/%.o)
DEPS := $(OBJECTS:.o=.d)
BUILD_CONFIG := $(BUILD_DIR)/build-config
EXTRA_CFLAGS :=
EXTRA_LDFLAGS :=

ifneq ($(asan),)
EXTRA_CFLAGS += -fsanitize=address
EXTRA_LDFLAGS += -fsanitize=address
endif

# Opt-in host-tuned build: `make native=1`. Faster on the build machine, but the
# resulting binaries are NOT portable (may SIGILL on other CPUs) and must not be
# shipped in the distributable/Electron bundle.
ifneq ($(native),)
EXTRA_CFLAGS += -march=native
endif

.PHONY: all clean test help FORCE

all: $(PROG)

# One executable exposes every operation through explicit subcommands.
dstoreqc: $(OBJECTS) Makefile
	$(CC) $(LDFLAGS) $(EXTRA_LDFLAGS) $(THREAD_FLAGS) -o $@ $(OBJECTS) $(LDLIBS)

$(BUILD_DIR)/%.o: %.c $(BUILD_CONFIG)
	@mkdir -p "$(@D)"
	$(CC) $(CPPFLAGS) $(CFLAGS) $(EXTRA_CFLAGS) $(THREAD_FLAGS) -MMD -MP -c $< -o $@

# Update the stamp only when the toolchain or flags change. This also detects
# switching back from native/ASan builds without requiring a manual clean.
# Quote each value literally, including compiler flags containing single quotes.
shell_quote = '$(subst ','"'"',$(1))'
config_values = $(foreach var,CC CPPFLAGS CFLAGS EXTRA_CFLAGS LDFLAGS EXTRA_LDFLAGS THREAD_FLAGS LDLIBS SOURCES,$(call shell_quote,$(var)=$($(var))))
# Older make versions compare timestamps at second precision. Force every
# object to rebuild on a configuration change, even within the same second.
ifneq ($(shell printf '%s\n' $(config_values) | cmp -s - "$(BUILD_CONFIG)" || printf changed),)
.PHONY: $(BUILD_CONFIG)
endif

$(BUILD_CONFIG): FORCE
	@mkdir -p "$(@D)"
	@printf '%s\n' $(config_values) > "$@.tmp"
	@if ! cmp -s "$@.tmp" "$@"; then mv -f "$@.tmp" "$@"; fi
	@rm -f "$@.tmp"

FORCE:

# Build the tools and run the unit + end-to-end test suite.
test:
	./tests/run.sh

clean:
	rm -rf $(BUILD_DIR) *.dSYM $(PROG) tests/unit_core tests/unit_bloom

help:
	@printf '%s\n' \
	  'make                 Build the unified dstoreqc executable' \
	  'make dstoreqc        Build only the unified executable' \
	  'make -j4             Build source files in parallel' \
	  'make asan=1          Build with AddressSanitizer' \
	  'make native=1        Build for the current CPU (not portable)' \
	  'make test            Run the C and CLI test suites' \
	  'make clean           Remove build artifacts and executables'

-include $(DEPS)
