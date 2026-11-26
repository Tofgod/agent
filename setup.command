#!/bin/bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
exec /bin/bash ./start.command --setup "$@"
