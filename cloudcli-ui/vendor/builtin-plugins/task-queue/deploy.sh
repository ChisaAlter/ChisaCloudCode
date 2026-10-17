#!/usr/bin/env bash
# Build and deploy the plugin to CloudCLI's plugins directory.
# Usage: ./deploy.sh
# After deploying: pm2 restart cloudcli  (required to reload the plugin server)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$HOME/.claude-code-ui/plugins/cloudcli-plugin-task-queue"

echo "[task-queue] Building..."
cd "$REPO_DIR"
npm run build

echo "[task-queue] Deploying to $PLUGIN_DIR..."
rm -rf "$PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR/dist"
cp "$REPO_DIR/manifest.json" "$REPO_DIR/package.json" "$REPO_DIR/icon.svg" "$PLUGIN_DIR/"
cp -r "$REPO_DIR/dist/"* "$PLUGIN_DIR/dist/"
if [ -d "$REPO_DIR/node_modules" ]; then
  cp -r "$REPO_DIR/node_modules" "$PLUGIN_DIR/node_modules"
fi

echo "[task-queue] Done. Restart CloudCLI to activate: pm2 restart cloudcli"
