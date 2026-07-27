FROM node:22-bookworm-slim

# ffmpeg/ffprobe  - src/media/ffmpeg.ts:23,47,58 and src/stages/qc.ts:93,132,144
#                   invoke them by bare name through execa.
# fonts-inter     - remotion/Root.tsx:12 defaults font:'Inter' and Captions.tsx:54
#                   passes it to Chrome as a CSS fontFamily. A missing font is a
#                   SILENT fallback to generic sans, not an error, and QC checks
#                   frames and duration but never typeface.
# tzdata          - src/publish/schedule.ts's publish window/pacing is
#                   local-wall-clock by design.
# lib*            - Chrome headless shell's runtime dependency closure.
# python3/g++     - better-sqlite3 and onnxruntime-node build from source when no
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

# supercronic: cron built for containers — logs every job to stdout, runs fine as
# PID 1 and as a non-root user, and does not overlap a job with itself.
ENV SUPERCRONIC_VERSION=v0.2.48 \
    SUPERCRONIC_SHA256SUM=50ae8755e04fa72812d0a1bc47a112a856811cc91cce7b6c875c378a850788bc
RUN curl -fsSLO "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-arm64" \
 && echo "${SUPERCRONIC_SHA256SUM}  supercronic-linux-arm64" | sha256sum -c - \
 && chmod +x supercronic-linux-arm64 \
 && mv supercronic-linux-arm64 /usr/local/bin/supercronic

ENV TZ=America/Chicago
RUN corepack enable && corepack prepare pnpm@11.12.0 --activate

WORKDIR /app
RUN chown node:node /app
USER node

# Dependency layers first so a source edit does not reinstall node_modules.
# pnpm-workspace.yaml is required here, not incidental: its allowBuilds list is
# what permits better-sqlite3 and onnxruntime-node to run install scripts.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Bake the headless browser as its own layer while it only needs node_modules,
# so a source edit below does not invalidate this ~217 MB download. Must stay
# above the full-source COPY for that reason.
RUN pnpm exec remotion browser ensure

COPY --chown=node:node . .

# warm-kokoro imports KOKORO_MODEL_ID from src/stages/voice.ts, so unlike the
# browser layer above it genuinely needs the source copy and must stay below it.
RUN pnpm exec tsx deploy/docker/warm-kokoro.ts

# -passthrough-logs: without it supercronic wraps each job's stdout in its own
# logfmt line (`msg="{...}"`, braces/quotes escaped), which breaks the CLI's
# one-JSON-line-per-tick contract relied on by ~10 source comments and the
# README. With the flag, a tick's own JSON reaches `docker compose logs` bare.
CMD ["supercronic", "-passthrough-logs", "/app/deploy/docker/crontab"]
