#!/bin/sh
set -eu

CDPATH= cd -P "$(dirname "$0")"
exec /bin/sh ./start.sh --setup "$@"
