# CFG Visualizer backend — Dockerfile for Render / Fly / Railway / etc.
#
# Strategy: build radare2 from source. radare2 is no longer in any default
# Debian/Ubuntu repo (it was pulled when the upstream maintainer stepped
# back). The radare.org third-party repo's signing key is also currently
# unreachable (404). Source build is the only reliable path.
#
# Tradeoff: first build takes 5-10 min on Render's 0.1 vCPU. The result
# is cached as a Docker layer, so subsequent deploys are instant.
FROM python:3.12-bookworm

# Build tools + curl. r2 needs gcc, make, git, pkg-config, and a C compiler.
# After the build we purge these to keep the final image small.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        git \
        pkg-config \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Build radare2 from source. Pinned to 5.9.4 — a stable release that's been
# tested with our analyzer. The `sys/install.sh` script handles all the
# configure/make/install steps and is the official r2 build path.
ARG R2_VERSION=5.9.4
RUN git clone --depth 1 --branch "${R2_VERSION}" https://github.com/radareorg/radare2.git /tmp/r2 \
    && cd /tmp/r2 \
    && ./sys/install.sh \
    && cd / \
    && rm -rf /tmp/r2

# Sanity check — fail the build early if r2 isn't where we expect.
RUN r2 -v | head -1

# Drop the build tools now that r2 is installed. The runtime image is
# ~300 MB smaller without gcc/git/pkg-config.
RUN apt-get purge -y --auto-remove build-essential git pkg-config \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

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
