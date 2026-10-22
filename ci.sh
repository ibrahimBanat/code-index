#!/bin/sh
# Dev wrapper: CI_ROOT=/path/to/repo ./ci.sh <command> [args] — runs the CLI from source.
: "${CI_ROOT:?set CI_ROOT to the repo to index}"
exec npx tsx "$(dirname "$0")/src/cli.ts" "$@" --root "$CI_ROOT"
