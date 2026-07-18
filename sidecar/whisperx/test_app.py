import io
import wave

import numpy as np
from fastapi.testclient import TestClient

import app as app_module


def _wav_bytes(seconds=1, rate=16000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * rate * seconds)
    return buf.getvalue()


def test_align_returns_word_timings(monkeypatch):
    monkeypatch.setattr(
        app_module.whisperx, "load_align_model",
        lambda language_code, device: (object(), {"language": "en"}),
    )
    monkeypatch.setattr(
        app_module.whisperx, "load_audio",
        lambda p: np.zeros(16000, dtype=np.float32),
    )
    monkeypatch.setattr(
        app_module.whisperx, "align",
        lambda *a, **k: {
            "word_segments": [
                {"word": "hello", "start": 0.10, "end": 0.42, "score": 0.9},
                {"word": "world", "start": 0.55, "end": 0.90, "score": 0.9},
                {"word": "??", "score": 0.0},  # unalignable -> dropped
            ]
        },
    )
    app_module._align["model"] = None  # reset module-level cache
    client = TestClient(app_module.app)
    resp = client.post(
        "/align",
        files={"audio": ("narration.wav", _wav_bytes(), "audio/wav")},
        data={"transcript": "hello world"},
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "words": [
            {"word": "hello", "start": 0.10, "end": 0.42},
            {"word": "world", "start": 0.55, "end": 0.90},
        ]
    }


def test_align_missing_transcript_is_422():
    client = TestClient(app_module.app)
    resp = client.post("/align", files={"audio": ("n.wav", _wav_bytes(), "audio/wav")})
    assert resp.status_code == 422
