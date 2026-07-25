import { existsSync, promises as fs } from 'node:fs';
import { z } from 'zod';
import { assertBudget, recordCost, BudgetExceededError } from '../jobs/costs.js';
import type { JobContext, StageDef } from '../jobs/types.js';
import { probe } from '../media/ffmpeg.js';
import { visionJudgment } from '../providers/anthropic.js';
import { animateImage, estimateImageCostMicros, estimateVideoCostMicros, generateImage } from '../providers/fal.js';
import { errorCostUsdMicros } from '../providers/errors.js';
import type { WordTiming } from '../providers/whisperx.js';
import { MAX_CLIP_MS, MIN_CLIP_MS } from './clip-bounds.js';
import { computeSceneWindows } from './scene-windows.js';
import { isScenesOutput, type ScenesOutput, type ScriptArtifact } from './script.js';

// Pre-flight budget reservation for one keyframe vision check (~$0.015 of
// Sonnet 5 with a single image attached); the ledger records the actual
// token-priced cost afterwards. Same estimate the qc vision spot check uses.
export const ESTIMATED_VISION_COST_MICROS = 15_000;

// Keyframe loop: attempt counts include the first try, so 3 = one generation
// plus up to two critique-driven regenerations (spec 4.4). Animate: one retry
// on provider error.
const MAX_IMAGE_ATTEMPTS = 3;
const MAX_VIDEO_ATTEMPTS = 2;

// A scene window shorter than this has essentially no spoken time — almost
// always an empty/near-empty narration. Refuse to spend on it: fail before any
// paid keyframe or clip call.
const MIN_SCENE_WINDOW_MS = 250;

export interface SceneManifestEntry {
  index: number; // 1-based, matching the scene-NN file names
  startMs: number;
  endMs: number;
  keyframe: string; // file name relative to the visuals artifact dir
  clip: string; // file name relative to the visuals artifact dir
  clipDurationSec: 5 | 10; // smallest native clip length covering the window
  imageAttempts: number; // 0 when the scene was reused from a previous attempt
  videoAttempts: number; // 0 when reused
  costUsdMicros: number; // per-scene spend this run; 0 when reused
}

export interface ScenesManifest {
  method: 'aligned' | 'proportional';
  scenes: SceneManifestEntry[];
}

/**
 * Ordered concurrency-limited map. Every item runs to settlement even after an
 * earlier item's callback rejects (maximum resume progress: later scenes still
 * land their artifacts); only once all items have settled does the first error
 * propagate. Results are index-aligned with `items`.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const errors: unknown[] = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(Math.floor(limit), items.length)) },
    async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        try {
          results[i] = await fn(items[i], i);
        } catch (err) {
          errors.push(err);
        }
      }
    },
  );
  await Promise.all(workers);
  if (errors.length > 0) throw errors[0];
  return results;
}

const KeyframeJudgmentSchema = z.object({ pass: z.boolean(), critique: z.string() });

// Calibration matters here: a "strict" judge demanding exact compositional
// fidelity rejected 21/21 objectively usable keyframes in the first real run
// (2026-07-20) — image models approximate composition by nature. The keyframe
// is a background visual behind narration and captions; the gate exists to
// catch unusable images, not to art-direct pixel placement.
const KEYFRAME_JUDGE_SYSTEM =
  'You are a pragmatic art director reviewing AI-generated keyframes for a short-form vertical video. ' +
  'The keyframe is a background visual behind narration and captions, not a technical illustration. ' +
  'Judge only what is actually visible in the image, and approve anything usable.';

function buildJudgePrompt(styleBlock: string, visualPrompt: string): string {
  return [
    'Review the attached keyframe candidate against its brief.',
    `Intended style: ${styleBlock}`,
    `Intended content: ${visualPrompt}`,
    'Image models approximate: minor compositional deviations from the intended content are expected ' +
      'and are NOT a reason to fail. Pass the image if it shows the right subject, roughly matches the ' +
      'intended style, and is coherent.',
    'Fail it ONLY for: the wrong subject entirely, mangled anatomy, garbled text, or an incoherent or ' +
      'otherwise unusable composition.',
    'If it fails, set pass=false with one concrete, actionable critique for the next generation attempt; ' +
      'otherwise set pass=true with an empty critique.',
  ].join('\n\n');
}

type SceneOutcome =
  | { ok: true; entry: SceneManifestEntry }
  | { ok: false; sceneLabel: string; error: unknown };

export const visualsPremiumStage: StageDef = {
  name: 'visuals',
  async run(ctx: JobContext): Promise<void> {
    const script = JSON.parse(
      await fs.readFile(ctx.artifactPath('script', 'script.json'), 'utf8'),
    ) as ScriptArtifact;
    if (!isScenesOutput(script)) {
      // A premium visuals run over a story script means the job was scripted
      // for the wrong tier; nothing downstream can repair that, so fail hard.
      throw new Error(
        "visuals: premium visuals require a scenes-format script, but script.json is story-format (no format: 'scenes')",
      );
    }
    const { words } = JSON.parse(
      await fs.readFile(ctx.artifactPath('captions', 'words.json'), 'utf8'),
    ) as { words: WordTiming[] };
    const voice = JSON.parse(
      await fs.readFile(ctx.artifactPath('voice', 'voice.json'), 'utf8'),
    ) as { durationMs: number };

    const { windows, method } = computeSceneWindows(script, words, voice.durationMs);

    // Zero-length window spend guard: a collapsed window (a scene with no spoken
    // time, e.g. an empty narration that slipped past the schema) would burn a
    // keyframe + clip on an unusable scene. Fail here, before any paid call.
    windows.forEach((w, i) => {
      const spanMs = w.endMs - w.startMs;
      if (spanMs < MIN_SCENE_WINDOW_MS) {
        throw new Error(
          `visuals: scene ${i + 1} window is ${spanMs}ms, under the ${MIN_SCENE_WINDOW_MS}ms minimum (empty or too-short narration?)`,
        );
      }
    });

    const { imageModel, videoModel, sceneConcurrency } = ctx.channel.premium;

    // In-process budget reservation. assertBudget alone races under scene
    // concurrency: every worker reads the same ledger, so with sceneConcurrency
    // > 1 several gates can pass on the same headroom before any actual cost
    // lands, jointly overshooting the cap. Single-process JS interleaves only
    // at awaits, so the synchronous check-then-reserve below (no await between
    // assertBudget and the increment) is atomic: an in-flight estimate counts
    // against the cap until fn() has ledgered the actual cost, and the
    // reservation is released in `finally`. This bounds spend for one produce
    // run — cross-process concurrency is out of scope until the Plan 3 daemon.
    let reservedMicros = 0;
    async function withBudget<T>(estimate: number, fn: () => Promise<T>): Promise<T> {
      assertBudget(ctx.db, ctx.channel, ctx.jobId, estimate + reservedMicros, 'premium');
      reservedMicros += estimate;
      try {
        return await fn();
      } finally {
        reservedMicros -= estimate;
      }
    }

    // Every paid provider call in this stage ledgers under the same rule: on
    // success record the actual cost the response reports, on failure record
    // whatever the error says was already billed (a fal call billed before its
    // download failed, a paid vision response that failed schema validation)
    // and rethrow untouched, so a failing scene never loses its spend. The
    // cost is read through `costOf` because the shapes differ — fal returns
    // { costUsdMicros }, visionJudgment returns { data, cost }.
    async function ledgered<T>(
      provider: string,
      operation: string,
      costOf: (result: T) => number,
      call: () => Promise<T>,
    ): Promise<T> {
      try {
        const result = await call();
        recordCost(ctx.db, ctx.jobId, provider, operation, costOf(result));
        return result;
      } catch (err) {
        const paid = errorCostUsdMicros(err);
        if (paid !== undefined) recordCost(ctx.db, ctx.jobId, provider, operation, paid);
        throw err;
      }
    }

    const perScene = async (scene: ScenesOutput['scenes'][number], i: number): Promise<SceneManifestEntry> => {
      const nn = String(i + 1).padStart(2, '0');
      const keyframeName = `scene-${nn}.png`;
      const clipName = `scene-${nn}.mp4`;
      const keyframePath = ctx.artifactPath('visuals', keyframeName);
      const clipPath = ctx.artifactPath('visuals', clipName);
      const { startMs, endMs } = windows[i];
      const clipDurationSec: 5 | 10 = endMs - startMs <= 5000 ? 5 : 10;

      // Per-scene resume checkpoint, one level below stage idempotency: a clip
      // on disk is a finished scene, so a re-run only pays for what is missing.
      // But a run killed mid-download can leave a truncated/corrupt file, so
      // don't trust the clip blindly: probe it and reuse only if it decodes and
      // lands inside the same sane duration bounds premium QC enforces.
      // Otherwise delete just the clip (the keyframe, a png, is left in place)
      // and fall through to the normal generation path.
      if (existsSync(clipPath)) {
        let reusable = false;
        try {
          const { durationMs } = await probe(clipPath);
          reusable = durationMs >= MIN_CLIP_MS && durationMs <= MAX_CLIP_MS;
        } catch {
          reusable = false;
        }
        if (reusable) {
          ctx.log.info({ scene: nn }, 'visuals: clip exists, reusing');
          return {
            index: i + 1,
            startMs,
            endMs,
            keyframe: keyframeName,
            clip: clipName,
            clipDurationSec,
            imageAttempts: 0,
            videoAttempts: 0,
            costUsdMicros: 0,
          };
        }
        ctx.log.warn({ scene: nn }, 'visuals: existing clip failed probe/bounds, regenerating');
        await fs.rm(clipPath, { force: true });
      }

      let costUsdMicros = 0;
      let imageAttempts = 0;
      let critique = '';
      let approved = false;
      while (!approved) {
        const prompt =
          `${script.styleBlock}\n\n${scene.visualPrompt}` +
          (critique === ''
            ? ''
            : `\n\nA previous attempt at this image was rejected for this reason; fix it: ${critique}`);
        // Gate + reserve, then generate + ledger inside the reservation window.
        // A billed-but-failed attempt is ledgered by `ledgered` and the scene
        // then fails per the existing semantics — images are not retried on a
        // hard throw.
        const image = await withBudget(estimateImageCostMicros(imageModel), () =>
          ledgered('fal', 'image', (r) => r.costUsdMicros, () =>
            generateImage({ model: imageModel, prompt, outPath: keyframePath }),
          ),
        );
        imageAttempts += 1;
        costUsdMicros += image.costUsdMicros;

        const judgment = await withBudget(ESTIMATED_VISION_COST_MICROS, () =>
          ledgered('anthropic', 'keyframe-check', (r) => r.cost.usdMicros, () =>
            visionJudgment({
              model: ctx.channel.scriptModel,
              system: KEYFRAME_JUDGE_SYSTEM,
              prompt: buildJudgePrompt(script.styleBlock, scene.visualPrompt),
              imagePaths: [keyframePath],
              schema: KeyframeJudgmentSchema,
            }),
          ),
        );
        costUsdMicros += judgment.cost.usdMicros;

        if (judgment.data.pass) {
          approved = true;
        } else {
          critique = judgment.data.critique;
          if (imageAttempts >= MAX_IMAGE_ATTEMPTS) {
            throw new Error(`keyframe rejected after ${imageAttempts} attempts: ${critique}`);
          }
          ctx.log.warn({ scene: nn, critique }, 'visuals: keyframe rejected, regenerating');
        }
      }

      let videoAttempts = 0;
      let animated = false;
      while (!animated) {
        try {
          // `ledgered` records a billed-but-failed attempt before the retry
          // logic below decides whether to try again, so a download-failed
          // attempt is never lost.
          const video = await withBudget(estimateVideoCostMicros(videoModel, clipDurationSec), () =>
            ledgered('fal', 'video', (r) => r.costUsdMicros, () =>
              animateImage({
                model: videoModel,
                imagePath: keyframePath,
                motionPrompt: scene.motionPrompt,
                durationSec: clipDurationSec,
                outPath: clipPath,
              }),
            ),
          );
          videoAttempts += 1;
          costUsdMicros += video.costUsdMicros;
          animated = true;
        } catch (err) {
          // A budget breach is an enforcement outcome, not a retryable provider
          // error: withBudget's gate throws it before the provider is dialed,
          // and the retry loop must not swallow it.
          if (err instanceof BudgetExceededError) throw err;
          // A download-failed attempt was paid and ledgered above; fold its cost
          // into the per-scene total too so a scene that recovers on retry still
          // reports its full spend in the manifest.
          const paid = errorCostUsdMicros(err);
          if (paid !== undefined) costUsdMicros += paid;
          videoAttempts += 1;
          if (videoAttempts >= MAX_VIDEO_ATTEMPTS) {
            throw new Error(
              `animate failed after ${videoAttempts} attempts: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          ctx.log.warn({ scene: nn, err }, 'visuals: animate failed, retrying');
        }
      }

      return {
        index: i + 1,
        startMs,
        endMs,
        keyframe: keyframeName,
        clip: clipName,
        clipDurationSec,
        imageAttempts,
        videoAttempts,
        costUsdMicros,
      };
    };

    // perScene never rejects through mapWithConcurrency: each scene's error is
    // captured as a SceneOutcome so every scene settles and the stage decides
    // what to raise afterwards.
    const outcomes = await mapWithConcurrency(
      script.scenes,
      sceneConcurrency,
      async (scene, i): Promise<SceneOutcome> => {
        try {
          return { ok: true, entry: await perScene(scene, i) };
        } catch (error) {
          return { ok: false, sceneLabel: String(i + 1).padStart(2, '0'), error };
        }
      },
    );

    const failures = outcomes.filter((o): o is Extract<SceneOutcome, { ok: false }> => !o.ok);
    if (failures.length > 0) {
      // A budget breach must surface as itself so the runner parks the job
      // 'blocked' instead of 'failed'.
      const budget = failures
        .map((f) => f.error)
        .find((e): e is BudgetExceededError => e instanceof BudgetExceededError);
      if (budget) throw budget;
      const details = failures
        .map((f) => `scene ${f.sceneLabel}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
        .join('; ');
      throw new Error(`visuals: ${failures.length}/${script.scenes.length} scene(s) failed: ${details}`);
    }

    const manifest: ScenesManifest = {
      method,
      scenes: outcomes.filter((o): o is Extract<SceneOutcome, { ok: true }> => o.ok).map((o) => o.entry),
    };
    await fs.writeFile(ctx.artifactPath('visuals', 'scenes.json'), JSON.stringify(manifest, null, 2));
    ctx.log.info({ scenes: manifest.scenes.length, method }, 'visuals: premium scenes complete');
  },
};
