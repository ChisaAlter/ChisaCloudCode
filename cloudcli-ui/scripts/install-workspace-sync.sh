#!/bin/sh
set -eu

# Run once as part of the Linux server installation, before accepting desktop logins.
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
docker build --tag localhost/chisa-workspace-sync:1 "$task_root/server/modules/workspace-sync/transport"
