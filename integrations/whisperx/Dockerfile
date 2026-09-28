FROM python:3.11-slim

# ffmpeg is required by whisperx.load_audio; git for pip VCS deps.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only torch AND torchaudio wheels, installed together from the PyTorch CPU
# index BEFORE the requirements install. whisperx (via pyannote.audio) needs
# torchaudio; if it isn't already present, `pip install -r requirements.txt`
# pulls torchaudio from PyPI, whose default linux/aarch64 (and x86_64) wheels are
# CUDA builds that link libcudart and crash on import in this CPU-only image.
# 2.5.1 is a matched torch/torchaudio pair and satisfies whisperx 3.3.1's
# torch>=2 / torchaudio>=2 (and pyannote.audio 3.3.2's torchaudio>=2.2.0), so
# pip keeps these installed CPU builds instead of re-resolving them.
RUN pip install --no-cache-dir torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV WHISPERX_DEVICE=cpu
EXPOSE 8585
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8585"]
