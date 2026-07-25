/**
 * Sanity bounds for one premium scene clip, in milliseconds. fal generates
 * clips at a native 5s or 10s, so anything outside this range is a truncated
 * or corrupt encode.
 *
 * Deliberately shared rather than duplicated: premium QC rejects a clip
 * outside these bounds (src/stages/qc.ts), and the visuals resume checkpoint
 * (src/stages/visuals-premium.ts) reuses an on-disk clip only if it probes
 * inside them. Two copies could drift into a state where a clip is reused on
 * resume and then failed by QC on the very same run.
 */
export const MIN_CLIP_MS = 3000;
export const MAX_CLIP_MS = 15000;
