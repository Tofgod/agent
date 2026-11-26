#!/bin/sh
set -eu

CDPATH= cd -P "$(dirname "$0")"
exec /bin/bash ./start.command --setup "$@"
