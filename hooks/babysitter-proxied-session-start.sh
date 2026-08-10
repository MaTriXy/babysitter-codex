#!/bin/bash
# Session start — proxies the Codex hook event to the Babysitter SDK.
set -uo pipefail
BSIT_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$BSIT_SCRIPT_DIR/babysitter-hook-lib.sh"
bsit_invoke session-start
