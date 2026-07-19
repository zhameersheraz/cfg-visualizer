# CFG Visualizer backend — Dockerfile for Render / Fly / Railway / etc.
#
# Multi-stage: stage 1 pulls the official radare2 image (built by the
# r2 team, so the binary is known-good), stage 2 is a slim Python image
# with r2 artifacts copied over.
#
# Why not build r2 from source? Two failed attempts — first because
# ./sys/install.sh picked the wrong build path, then because the meson
# build silently failed mid-step. The official image sidesteps both.

# ----- Stage 1: grab r2 from the official image -----
FROM radare/radare2:5.9.4 AS r2-builder

# Diagnostic: print where r2 lives in the official image. If this changes
# in a future r2 release we'll see it here and can adjust the COPY paths.
RUN which r2 && r2 -v | head -1 \
    && echo "---" \
    && ls -la /usr/local/bin/r2* /usr/local/lib/libr_*.so* 2>/dev/null | head -20

# ----- Stage 2: runtime image -----
FROM python:3.12-bookworm

# Just curl for the Render healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        liblz4-1 \
    && rm -rf /var/lib/apt/lists/*

# Copy r2 binaries, libraries, and data files from the official image.
# We copy /usr/local/bin and /usr/local/lib selectively so we don't pull
# in any unrelated Python site-packages or other build artifacts.
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
