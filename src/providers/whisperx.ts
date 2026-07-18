import { readFile } from 'node:fs/promises';

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export async function alignTranscript(opts: {
  baseUrl: string;
  wavPath: string;
  transcript: string;
  timeoutMs?: number;
}): Promise<WordTiming[]> {
  const bytes = await readFile(opts.wavPath);
  const form = new FormData();
  form.append('audio', new Blob([bytes], { type: 'audio/wav' }), 'narration.wav');
  form.append('transcript', opts.transcript);

  // Without a timeout a hung sidecar wedges the align stage forever. Abort the fetch
  // after timeoutMs and rethrow with a message that names the sidecar and the budget.
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl}/align`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`alignTranscript: whisperx align timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`alignTranscript: whisperx responded ${res.status}: ${raw}`);
  }

  const body = (await res.json()) as { words: { word: string; start: number; end: number }[] };
  return body.words.map((w) => ({
    word: w.word,
    startMs: Math.round(w.start * 1000),
    endMs: Math.round(w.end * 1000),
  }));
}
