FROM node:22-bookworm-slim

# ffmpeg/ffprobe  - daemon/src/infra/media/ffmpeg.ts:23,47,58 and daemon/src/features/production/stages/qc.ts:93,132,144
#                   invoke them by bare name through execa.
# fonts-inter     - integrations/remotion/Root.tsx defaults font:'Inter' and
#                   Captions.tsx passes it to Chrome as a CSS fontFamily. A
#                   missing font is a SILENT fallback to generic sans, not an
#                   error, and QC checks frames and duration but never typeface.
# tzdata          - daemon/src/features/reporting/worker.ts schedules the daily digest
#                   using local wall-clock time.
# lib*            - Chrome headless shell's runtime dependency closure.
# python3/g++     - better-sqlite3 builds from source when no
#                   prebuild matches; failing loudly at build beats failing at 3am.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg fontconfig fonts-inter tzdata \
      python3 build-essential \
      libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libasound2 libpango-1.0-0 libcairo2 libx11-6 libxcb1 libxext6 \
      libexpat1 libglib2.0-0 \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

ENV TZ=America/New_York
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate

WORKDIR /app
RUN chown node:node /app
USER node

# Dependency layers first so a source edit does not reinstall node_modules.
# pnpm-workspace.yaml is required here, not incidental: its allowBuilds list is
# what permits better-sqlite3 to run install scripts.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Bake the headless browser as its own layer while it only needs node_modules,
# so a source edit below does not invalidate this ~217 MB download. Must stay
# above the full-source COPY for that reason.
RUN pnpm exec remotion browser ensure

COPY --chown=node:node . .

# Build request-rendered dashboard without provider keys or runtime state.
RUN pnpm dashboard:build

CMD ["pnpm", "brainrot", "run"]
