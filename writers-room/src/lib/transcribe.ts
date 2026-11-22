// Speech-to-text. One provider (Deepgram), called only from the server, under
// its business terms, with the Model Improvement Program opt-out on every
// request so the audio is never kept or used for training. See DECISIONS.md.

export class TranscriptionNotConfigured extends Error {}

export const transcriptionProvider = () =>
  !process.env.DEEPGRAM_API_KEY && process.env.WR_FAKE_TRANSCRIPT ? "fake (local testing)" : "deepgram";

export async function transcribe(audio: Buffer, mimeType: string): Promise<string> {
  // Local testing without a key: a fixed transcript stands in for real speech.
  const fake = process.env.WR_FAKE_TRANSCRIPT;
  if (fake && !process.env.DEEPGRAM_API_KEY) return fake;

  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    throw new TranscriptionNotConfigured(
      "Transcription isn't set up yet: add DEEPGRAM_API_KEY to the environment.",
    );
  }
  const params = new URLSearchParams({
    model: "nova-3",
    language: "en",
    punctuate: "true",
    smart_format: "true",
    // Keep "um"/"uh" in the raw transcript so it's a faithful record;
    // our own cleanup removes them afterwards.
    filler_words: "true",
    // Required for the no-training decision: without this, Deepgram enrolls
    // requests in its Model Improvement Program and keeps the audio. With it,
    // nothing is stored after the transcript comes back.
    mip_opt_out: "true",
  });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": mimeType.split(";")[0] || "application/octet-stream",
    },
    body: new Uint8Array(audio),
  });
  const body = (await res.json().catch(() => ({}))) as {
    err_msg?: string;
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  };
  if (!res.ok) {
    throw new Error(`Transcription failed (${res.status}): ${body.err_msg ?? "unknown error"}`);
  }
  return body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
}
