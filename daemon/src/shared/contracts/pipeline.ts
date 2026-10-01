/** Shared stage vocabulary; importing it never loads stage implementations. */
export const STAGE_ORDER = ['script', 'voice', 'captions', 'visuals', 'assemble', 'qc'] as const

export type StageName = (typeof STAGE_ORDER)[number]
