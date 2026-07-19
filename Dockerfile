# CFG Visualizer backend — Dockerfile for Render / Fly / Railway / etc.
#
# Base: python:3.12-bookworm. We pin to Debian 12 (bookworm) because
# radare2 is in the default `main` repo there. The current `python:3.12-slim`
# tag is on Debian 13 (trixie) which doesn't ship radare2.
FROM python:3.12-bookworm

# System deps: radare2 (the disassembler), curl (for Render healthcheck).
# --no-install-recommends keeps the image small.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        radare2 \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Sanity check — fail the build early if r2 isn't where we expect.
RUN r2 -v | head -1

# Set up app directory
WORKDIR /app

# Install Python deps first so this layer is cached when only the code changes.
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source.
COPY backend/ .

# Render sets PORT at runtime (defaults to 10000 on Render). HOST=0.0.0.0 so
# the server is reachable from outside the container.
ENV HOST=0.0.0.0
ENV CFG_UPLOAD_DIR=/tmp/cfg-visualizer-uploads
ENV CFG_SESSION_TTL=1800
# CORS: comma-separated list of allowed origins. Set this in your deploy
# platform's env vars to include your Vercel frontend URL.
# Example: CFG_CORS_ORIGINS=https://cfg-visualizer-eight.vercel.app

EXPOSE 8000

# Render's default healthcheck hits /. The /healthz endpoint returns
# {"ok":true,"sessions":N} which the platform interprets as 200/healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:${PORT}/healthz || exit 1

# Run uvicorn via main.py so the env-driven config (host/port) is honored.
CMD ["python", "main.py"]
