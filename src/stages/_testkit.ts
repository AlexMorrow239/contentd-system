import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { openDb } from '../db/index.js';
import { createJob } from '../jobs/runner.js';
import type { JobContext } from '../jobs/types.js';
import type { ChannelConfig } from '../config/channel.js';

export function testChannel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    name: 'test',
    niche: ['space facts', 'astronomy'],
    tierMix: { volume: 2, premium: 1 },
    voice: { volume: 'af_heart' },
    captionStyle: { font: 'Inter', fontSizePx: 72, activeColor: '#FFD700', inactiveColor: '#FFFFFF', strokePx: 8 },
    bgDir: 'assets/bg',
    bgmDir: 'assets/bgm',
    budget: { perVideoUsdMicros: 8_000_000, perDayUsdMicros: 20_000_000 },
    scriptModel: 'claude-sonnet-5',
    ...overrides,
  };
}

export function makeCtx(channel: ChannelConfig = testChannel(), topic = 'Why the Moon is drifting away'): JobContext {
  const db = openDb(':memory:');
  const jobId = createJob(db, channel, { topic, tier: 'volume' });
  const runDir = mkdtempSync(path.join(os.tmpdir(), 'brainrot-test-'));
  return {
    jobId,
    db,
    channel,
    tier: 'volume',
    topic,
    runDir,
    artifactPath(stage, file) {
      const dir = path.join(runDir, stage);
      mkdirSync(dir, { recursive: true });
      return path.join(dir, file);
    },
    log: pino({ level: 'silent' }),
  };
}
