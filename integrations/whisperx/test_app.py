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


def test_default_upload_cap_is_64_mib():
    # Cap is read from WHISPERX_MAX_UPLOAD_MB at import time; the test env does
    # not set it, so the module must expose the 64 MiB default.
    assert app_module.MAX_UPLOAD_BYTES == 64 * 1024 * 1024


def test_oversized_upload_is_413_before_alignment(monkeypatch):
    calls = []
    monkeypatch.setattr(
        app_module.whisperx, "load_align_model",
        lambda language_code, device: calls.append("load_align_model"),
    )
    monkeypatch.setattr(
        app_module.whisperx, "load_audio", lambda p: calls.append("load_audio")
    )
    monkeypatch.setattr(
        app_module.whisperx, "align", lambda *a, **k: calls.append("align")
    )
    monkeypatch.setattr(app_module, "MAX_UPLOAD_BYTES", 1000)  # 1s wav is ~32 KiB
    app_module._align["model"] = None  # reset module-level cache
    client = TestClient(app_module.app)
    resp = client.post(
        "/align",
        files={"audio": ("narration.wav", _wav_bytes(), "audio/wav")},
        data={"transcript": "hello world"},
    )
    assert resp.status_code == 413
    assert "exceeds" in resp.json()["detail"]
    assert calls == []  # rejected before any whisperx work ran


def test_oversized_content_length_is_413_before_body_parse(monkeypatch):
    # The middleware rejects on the declared Content-Length before Starlette
    # parses the multipart body, so neither the handler nor any whisperx call
    # is ever reached.
    calls = []
    monkeypatch.setattr(
        app_module.whisperx, "load_align_model",
        lambda language_code, device: calls.append("load_align_model"),
    )
    monkeypatch.setattr(
        app_module.whisperx, "load_audio", lambda p: calls.append("load_audio")
    )
    monkeypatch.setattr(
        app_module.whisperx, "align", lambda *a, **k: calls.append("align")
    )

    def _handler_ran(*a, **k):
        raise AssertionError("handler body executed; middleware did not reject")

    # If the middleware short-circuits, the handler never opens the temp file.
    monkeypatch.setattr(app_module.tempfile, "NamedTemporaryFile", _handler_ran)
    # ~32 KiB wav body must exceed MAX_UPLOAD_BYTES + FORM_OVERHEAD_BYTES.
    monkeypatch.setattr(app_module, "MAX_UPLOAD_BYTES", 1000)
    monkeypatch.setattr(app_module, "FORM_OVERHEAD_BYTES", 100)
    app_module._align["model"] = None  # reset module-level cache
    client = TestClient(app_module.app)
    resp = client.post(
        "/align",
        files={"audio": ("narration.wav", _wav_bytes(), "audio/wav")},
        data={"transcript": "hello world"},
    )
    assert resp.status_code == 413
    detail = resp.json()["detail"]
    assert "exceeds" in detail  # mirrors the in-handler 413 wording
    assert "Content-Length" in detail  # ...and is distinctly middleware-origin
    assert calls == []  # no whisperx work ran


def test_default_form_overhead_is_1_mib():
    assert app_module.FORM_OVERHEAD_BYTES == 1024 * 1024


def test_chunked_write_preserves_bytes(monkeypatch):
    wav = _wav_bytes()
    seen = {}

    def fake_load_audio(path):
        with open(path, "rb") as f:
            seen["bytes"] = f.read()
        return np.zeros(16000, dtype=np.float32)

    monkeypatch.setattr(
        app_module.whisperx, "load_align_model",
        lambda language_code, device: (object(), {"language": "en"}),
    )
    monkeypatch.setattr(app_module.whisperx, "load_audio", fake_load_audio)
    monkeypatch.setattr(
        app_module.whisperx, "align", lambda *a, **k: {"word_segments": []}
    )
    monkeypatch.setattr(app_module, "CHUNK_SIZE", 1024)  # force ~32 read iterations
    app_module._align["model"] = None  # reset module-level cache
    client = TestClient(app_module.app)
    resp = client.post(
        "/align",
        files={"audio": ("narration.wav", wav, "audio/wav")},
        data={"transcript": "hello world"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"words": []}
    assert seen["bytes"] == wav  # chunk-reassembled temp file is byte-identical


def test_health_returns_ok_without_loading_the_align_model(monkeypatch):
    # The align model is lazy (get_align_model) and takes a long time to
    # download on first call. Health must stay a liveness probe: if it ever
    # triggers a load, the compose healthcheck would time out on a cold start
    # and the app container would never come up.
    def explode(*args, **kwargs):
        raise AssertionError("/health must not load the align model")

    monkeypatch.setattr(app_module.whisperx, "load_align_model", explode)
    # Reset the cache so the trap is live; prior tests may have left the model
    # populated, which would short-circuit get_align_model() and miss the trap.
    app_module._align["model"] = None

    client = TestClient(app_module.app)
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_model_load_failure_returns_detail(monkeypatch):
    def fail():
        raise RuntimeError("model cache is unreadable")

    monkeypatch.setattr(app_module, "get_align_model", fail)
    monkeypatch.setattr(app_module.whisperx, "load_audio",
                        lambda p: np.zeros(16000, dtype=np.float32))
    client = TestClient(app_module.app, raise_server_exceptions=False)
    resp = client.post("/align", files={"audio": ("n.wav", _wav_bytes(), "audio/wav")},
                       data={"transcript": "hello"})
    assert resp.status_code == 500
    assert "model cache is unreadable" in resp.json()["detail"]


def test_audio_decode_failure_returns_detail(monkeypatch):
    def fail(path):
        raise RuntimeError("ffmpeg could not decode audio")

    monkeypatch.setattr(app_module.whisperx, "load_audio", fail)
    client = TestClient(app_module.app, raise_server_exceptions=False)
    resp = client.post("/align", files={"audio": ("n.wav", _wav_bytes(), "audio/wav")},
                       data={"transcript": "hello"})
    assert resp.status_code == 500
    assert "ffmpeg could not decode audio" in resp.json()["detail"]
