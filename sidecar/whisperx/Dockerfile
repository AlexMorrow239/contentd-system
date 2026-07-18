FROM python:3.11-slim

# ffmpeg is required by whisperx.load_audio; git for pip VCS deps.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only torch wheel (keeps the image small; no CUDA).
RUN pip install --no-cache-dir torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV WHISPERX_DEVICE=cpu
EXPOSE 8585
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8585"]
