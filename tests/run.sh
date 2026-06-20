#!/usr/bin/env bash
#
# Build the DBGPS tools and run the full test suite:
#   1. compile all three CLI tools with warnings treated as errors
#   2. compile and run the C unit tests for the shared k-mer core
#   3. run the Python end-to-end functional tests against the binaries
#
# Usage: tests/run.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CC="${CC:-cc}"

echo "==> Building CLI tools (warnings as errors)"
make clean >/dev/null 2>&1 || true
make CFLAGS="-g -Wall -Wextra -Werror -O2"

echo
echo "==> Building and running C unit tests"
if [ -f tests/unit_core.c ]; then
  "$CC" -g -Wall -Wextra -Werror -O2 -o tests/unit_core tests/unit_core.c
  ./tests/unit_core
else
  echo "    (tests/unit_core.c not present, skipping)"
fi

echo
echo "==> Running Python end-to-end functional tests"
python3 tests/test_cli.py

echo
echo "All tests passed."
