# CFG Visualizer backend — Dockerfile for Render / Fly / Railway / etc.
#
# Base: python:3.12-slim. We use 3.12 instead of 3.13 because all our deps
# have stable cp312 wheels (cp313 is fine too, but 3.12 is more battle-tested
# for server deploys). radare2 is NOT in the default Debian repos, so we
# add the official radare.org apt repo before installing.
FROM python:3.12-slim

# Install prerequisites: curl to fetch the r2 repo key, gnupg2 for the
# keyring, ca-certificates for HTTPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        gnupg2 \
    && rm -rf /var/lib/apt/lists/*

# Add radare.org's official Debian repo. They sign their repo with a
# GPG key we add to the trusted keyrings. The signed-by= option in the
# sources file ensures apt only trusts the key we just added.
RUN curl -fsSL https://radare.org/repo.gpg | gpg --dearmor -o /usr/share/keyrings/radare-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/radare-archive-keyring.gpg] https://radare.org/repo/ stable main" > /etc/apt/sources.list.d/radare.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        radare2 \
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
