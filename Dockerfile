# Run hara in a container — useful for CI, isolated/ephemeral runs, and as a step toward
# sandboxed execution. Multi-stage: build with full deps, ship a slim runtime that still has a
# shell + git + ripgrep (hara's bash/search tools need them — a distroless image would break them).
#
#   docker build -t hara .
#   # one-shot, on the current repo:
#   docker run --rm -v "$PWD:/workspace" -e HARA_API_KEY=sk-... hara -p "summarize this repo"
#   # interactive TUI:
#   docker run --rm -it -v "$PWD:/workspace" -e HARA_API_KEY=sk-... hara

# ── build: compile TS -> dist ───────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# --ignore-scripts: "prepare": "tsc" would fire here, BEFORE src/tsconfig are copied, and fail the
# build (this broke the release image job on every tag). The explicit `npm run build` below compiles.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY runtime-bootstrap.cjs ./
COPY scripts/normalize-dist-modes.mjs ./scripts/normalize-dist-modes.mjs
RUN npm run build

# ── deps: production-only node_modules ──────────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# --ignore-scripts: skip the "prepare": "tsc" hook (no src here, dist comes from `build`)
RUN npm ci --omit=dev --ignore-scripts

# ── runtime: slim, but with a shell + git + ripgrep for the tools ───────────
FROM node:22-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HARA_IN_DOCKER=1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY runtime-bootstrap.cjs ./
COPY package.json README.md ./
# Operate on the user's mounted repo, not /app.
WORKDIR /workspace
ENTRYPOINT ["node", "/app/runtime-bootstrap.cjs"]
