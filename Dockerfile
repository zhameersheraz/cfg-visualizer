# CFG Visualizer backend — Dockerfile for Render / Fly / Railway / etc.
#
# Multi-stage build: stage 1 builds radare2 from source, stage 2 is the
# slim runtime image with r2 binaries copied over. The radare2 build is
# the slow part (~5 min on Render free tier) but it's cached as its own
# layer, so future deploys skip it entirely.
#
# radare2 isn't in any current default Debian repo (it was pulled when
# the upstream maintainer stepped back), and radare.org's third-party
# apt repo is currently 404. Source build is the only reliable path.

# ----- Stage 1: build radare2 -----
FROM python:3.12-bookworm AS r2-builder

# Build tools. We keep them in the builder stage and discard the whole
# stage at the end (multi-stage = smaller final image, no autoremove
# risk of removing r2's runtime deps).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        git \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Build radare2 5.9.4 from source. The official sys/install.sh handles
# configure/make/install with /usr/local as the prefix.
ARG R2_VERSION=5.9.4
RUN git clone --depth 1 --branch "${R2_VERSION}" https://github.com/radareorg/radare2.git /tmp/r2 \
    && cd /tmp/r2 \
    && ./sys/install.sh \
    && cd / \
    && rm -rf /tmp/r2

# Verify r2 actually got installed. Fail the build here if not, so we
# don't waste a 5-min deploy cycle on a broken image.
RUN test -x /usr/local/bin/r2 || (echo "r2 not found at /usr/local/bin/r2" && exit 1) \
    && /usr/local/bin/r2 -v | head -1

# ----- Stage 2: runtime image -----
FROM python:3.12-bookworm

# Just curl for the Render healthcheck. Nothing else from apt — we copy
# r2 from the builder stage instead.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Copy radare2 binaries, libraries, and data files from the builder.
# We do this explicitly (not /usr/local/) to avoid dragging in any
# unrelated stuff that might be in the builder's /usr/local.
COPY --from=r2-builder /usr/local/bin/r2*            /usr/local/bin/
COPY --from=r2-builder /usr/local/bin/radare2*       /usr/local/bin/ 2>/dev/null || true
COPY --from=r2-builder /usr/local/lib/libr_*.so*     /usr/local/lib/
COPY --from=r2-builder /usr/local/lib/radare2/       /usr/local/lib/radare2/
COPY --from=r2-builder /usr/local/share/radare2/     /usr/local/share/radare2/

# Final verification — both at the binary level and via PATH resolution.
RUN test -x /usr/local/bin/r2 && r2 -v | head -1

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
