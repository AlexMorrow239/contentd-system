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
}): Promise<WordTiming[]> {
  const bytes = await readFile(opts.wavPath);
  const form = new FormData();
  form.append('audio', new Blob([bytes], { type: 'audio/wav' }), 'narration.wav');
  form.append('transcript', opts.transcript);

  const res = await fetch(`${opts.baseUrl}/align`, { method: 'POST', body: form });
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
