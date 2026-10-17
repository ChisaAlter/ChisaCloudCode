# ChisaCloudCode server (cloudcli-ui) container image.
#
# Build from the repository root:
#   docker build --build-arg COMMIT=$(git rev-parse --short HEAD) \
#     -f deploy/server/Dockerfile -t local/chisacloudcode:<tag> .
#
# The API container runs as root (it drives the host docker socket to manage
# per-account sync/worker/preview containers). The container itself is the
# sandbox boundary, which is why IS_SANDBOX=1 is set below: without it Claude
# Code refuses --dangerously-skip-permissions / bypassPermissions as root.
FROM node:24-bookworm AS build
ARG COMMIT=unknown
ENV HUSKY=0
WORKDIR /src/cloudcli-ui
COPY cloudcli-ui/package.json cloudcli-ui/package-lock.json ./
COPY cloudcli-ui/scripts ./scripts
RUN npm ci --no-audit --no-fund
COPY cloudcli-ui/ ./
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build
RUN C="$COMMIT" node -e "const fs=require('fs'); for (const f of ['shared/build-identity.json','dist-server/shared/build-identity.json']) { if (!fs.existsSync(f)) { console.log('skip', f); continue; } const j=JSON.parse(fs.readFileSync(f,'utf8')); j.commit=process.env.C; j.dirty=false; fs.writeFileSync(f, JSON.stringify(j)); console.log('identity', f, JSON.stringify(j)); }"
RUN npm prune --omit=dev --no-audit --no-fund

FROM docker:29-cli AS dockercli

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates python3 ripgrep procps tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app/cloudcli-ui
COPY --from=build /src/cloudcli-ui /app/cloudcli-ui

# The container is the sandbox; lets root use --dangerously-skip-permissions.
ENV IS_SANDBOX=1

# Put the Claude Code CLI on PATH. The web "Claude CLI Login" and the Shell tab
# run plain `claude` in a PTY, and the Agent SDK is handed `claude` on Linux,
# so the CLI must resolve from PATH. It ships as the Agent SDK's per-platform
# native binary; pick the one for this image's arch/libc and fail the build if
# npm did not install it (rather than shipping an image where login fails).
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64|amd64) arch=x64 ;; \
      aarch64|arm64) arch=arm64 ;; \
      *) echo "unsupported architecture for Claude Code: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    libc=""; \
    if [ -e /etc/alpine-release ] || (ldd --version 2>&1 || true) | grep -qi musl; then libc="-musl"; fi; \
    pkg="@anthropic-ai/claude-agent-sdk-linux-${arch}${libc}"; \
    bin="/app/cloudcli-ui/node_modules/${pkg}/claude"; \
    if [ ! -x "$bin" ]; then \
      echo "Claude Code native binary not found: $bin" >&2; \
      ls -d /app/cloudcli-ui/node_modules/@anthropic-ai/claude-agent-sdk* >&2 || true; \
      exit 1; \
    fi; \
    ln -sf "$bin" /usr/local/bin/claude; \
    claude --version

ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["npm","run","server"]
