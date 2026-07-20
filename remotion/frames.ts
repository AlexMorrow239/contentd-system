/**
 * Per-scene frame counts for a Series of scene clips, using cumulative rounding.
 *
 * Rounding each scene's durationMs -> frames independently drifts up to ±0.5
 * frame per scene, so over many scenes the Series can end a few frames short of
 * the composition length (a black flash at the tail). Rounding the running
 * cumulative boundary instead makes the per-scene counts telescope: their sum is
 * always exactly round(totalMs * fps / 1000), so the Series covers the full
 * timeline regardless of scene count.
 */
export function cumulativeSceneFrames(durationsMs: number[], fps: number): number[] {
  let cumStartMs = 0
  return durationsMs.map((durationMs) => {
    const cumEndMs = cumStartMs + durationMs
    const frames = Math.round((cumEndMs * fps) / 1000) - Math.round((cumStartMs * fps) / 1000)
    cumStartMs = cumEndMs
    return frames
  })
}
