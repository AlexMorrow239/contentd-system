import os
import tempfile

import whisperx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

app = FastAPI()

DEVICE = os.environ.get("WHISPERX_DEVICE", "cpu")
SAMPLE_RATE = 16000  # whisperx.load_audio always resamples to 16 kHz

# Uploads are streamed to the temp file in CHUNK_SIZE reads and rejected with
# 413 the moment the running total exceeds MAX_UPLOAD_BYTES — the request body
# is never held in a single bytes object. The cap is env-configurable
# (WHISPERX_MAX_UPLOAD_MB, default 64, read once at import like DEVICE). Both
# are module-level globals so tests can monkeypatch them.
CHUNK_SIZE = 1024 * 1024  # 1 MiB
MAX_UPLOAD_BYTES = int(os.environ.get("WHISPERX_MAX_UPLOAD_MB", "64")) * 1024 * 1024

# Starlette fully receives and parses the multipart body before the handler
# runs, so the in-handler streaming cap above never prevents the receive
# itself. The middleware below rejects an honest oversized request from its
# declared Content-Length before body parsing. FORM_OVERHEAD_BYTES is the slack
# added to MAX_UPLOAD_BYTES for multipart framing plus the transcript form
# field, so a genuine max-size audio upload is not falsely rejected. Referenced
# by bare name at request time so tests can monkeypatch it.
FORM_OVERHEAD_BYTES = 1024 * 1024  # 1 MiB


@app.middleware("http")
async def reject_oversized_content_length(request: Request, call_next):
    if request.method == "POST" and request.url.path == "/align":
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                declared = int(content_length)
            except ValueError:
                declared = None  # unparseable -> defer to the in-handler cap
            if declared is not None and declared > MAX_UPLOAD_BYTES + FORM_OVERHEAD_BYTES:
                return JSONResponse(
                    status_code=413,
                    content={
                        "detail": (
                            f"audio upload exceeds {MAX_UPLOAD_BYTES} byte limit "
                            f"(rejected from declared Content-Length)"
                        )
                    },
                )
    return await call_next(request)


@app.get("/health")
def health():
    """Liveness only. Deliberately does NOT touch get_align_model(): the model
    is lazy by design (see below), and warming it here would turn a fast probe
    into a multi-minute cold start that the compose healthcheck would read as a
    failed container. A healthy response therefore means "serving", not
    "alignment is warm" — the first real /align call still pays the load."""
    return {"ok": True}


# Alignment model is loaded once and cached at module level. Lazy so importing
# this module (e.g. in tests) does not trigger a model download.
_align: dict[str, object] = {"model": None, "metadata": None}


def get_align_model():
    if _align["model"] is None:
        model, metadata = whisperx.load_align_model(language_code="en", device=DEVICE)
        _align["model"] = model
        _align["metadata"] = metadata
    return _align["model"], _align["metadata"]


@app.post("/align")
async def align(audio: UploadFile = File(...), transcript: str = Form(...)):
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        received = 0
        while True:
            chunk = await audio.read(CHUNK_SIZE)
            if not chunk:
                break
            received += len(chunk)
            if received > MAX_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"audio upload exceeds {MAX_UPLOAD_BYTES} byte limit",
                )
            tmp.write(chunk)
        tmp.flush()
        audio_array = whisperx.load_audio(tmp.name)

    duration = len(audio_array) / SAMPLE_RATE
    # Alignment-only: one segment spanning the whole clip carries the plain
    # transcript; whisperx places each word within it.
    segments = [{"start": 0.0, "end": float(duration), "text": transcript}]
    model, metadata = get_align_model()
    try:
        result = whisperx.align(
            segments, model, metadata, audio_array, DEVICE, return_char_alignments=False
        )
    except Exception as exc:  # alignment failure -> 500 with detail
        raise HTTPException(status_code=500, detail=f"alignment failed: {exc}")

    words = [
        {"word": w["word"], "start": float(w["start"]), "end": float(w["end"])}
        for w in result.get("word_segments", [])
        if w.get("start") is not None and w.get("end") is not None
    ]
    return {"words": words}
