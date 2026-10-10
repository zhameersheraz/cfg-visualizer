# CFG Visualizer backend — Dockerfile for Render / Fly / Railway / etc.
#
# Single stage, radare2 installed from the r2 team's own .deb release.
#
# Why not the official radare/radare2 image? That image is snap-based: r2
# lives inside the snap at /snap/radare2/current/bin/r2 and the image runs as a
# non-root `r2` user. Copying r2 out of it does not work, because the paths the
# old multi-stage build assumed (/usr/local/bin/r2, /usr/local/lib/libr_*.so)
# simply do not exist in that image. That is why every deploy ended up serving
# a container with no radare2 at all: /upload answered 422 for every file.
#
# Why not apt? radare2 is not in Debian bookworm or trixie. Only sid and the
# older releases carry it. Verified against sources.debian.org rather than
# assumed, because "just apt install radare2" is the obvious thing to try.
#
# Why not build from source? Two attempts failed already (sys/install.sh picked
# the wrong path, then meson failed silently). The published .deb is the same
# artifact the r2 team ships to users, so it sidesteps all of that.
FROM python:3.12-bookworm

ARG R2_VERSION=5.9.4

# curl is for the Render healthcheck, liblz4-1 is an r2 runtime dep.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        liblz4-1 \
    && rm -rf /var/lib/apt/lists/*

# radare2 from the official GitHub release.
RUN curl -fsSL -o /tmp/r2.deb \
        "https://github.com/radareorg/radare2/releases/download/${R2_VERSION}/radare2_${R2_VERSION}_amd64.deb" \
    && apt-get update \
    && apt-get install -y --no-install-recommends /tmp/r2.deb \
    && rm -f /tmp/r2.deb \
    && rm -rf /var/lib/apt/lists/*

# Fail the build loudly rather than shipping a container that answers /healthz
# with ok:true and then 422s every upload. This check is the whole reason the
# previous deploy looked healthy while being completely useless.
RUN test -x "$(command -v r2)" \
    && r2 -v | head -1 \
    && r2 -qc 'q' /dev/null 2>/dev/null || true

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

# Render's default healthcheck hits /. The /healthz endpoint reports whether
# radare2 is actually present, so a missing r2 shows up as unhealthy instead of
# silently failing every upload.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:${PORT}/healthz || exit 1

# Run uvicorn via main.py so the env-driven config (host/port) is honored.
CMD ["python", "main.py"]