#!/bin/sh
# Dev wrapper: ./ci.sh <command> [args] — runs against $CI_ROOT (default: ../syarah)
exec npx tsx "$(dirname "$0")/src/cli.ts" "$@" --root "${CI_ROOT:-$(dirname "$0")/../syarah}"
