/**
 * api.js — thin wrapper around the FastAPI backend.
 *
 * The backend exposes:
 *   POST   /upload                 multipart binary
 *   GET    /function/{addr}?session_id=...
 *   GET    /overview?session_id=...
 *   DELETE /session/{sid}
 *
 * BASE_URL is auto-detected:
 *   - if served on the same origin as the frontend, default to the current host
 *   - otherwise the user can override with window.CFG_API_BASE before this
 *     module is imported
 */

// API base resolution order:
//   1. window.CFG_API_BASE (set in index.html or via a runtime config)
//   2. <meta name="cfg-api-base" content="..."> in index.html
//   3. Hard-coded BACKEND_URL below (set this when deploying)
//   4. Auto-detect: same hostname as the frontend, port 8000
//   5. Fallback: http://127.0.0.1:8000
//
// To deploy the backend alongside the Vercel frontend, set BACKEND_URL to
// your Render/Fly/Railway URL, e.g. "https://cfg-visualizer-backend.onrender.com".
const BACKEND_URL = "https://cfg-visualizer-backend.onrender.com";  // <-- set this to your deployed backend URL

function resolveBase() {
    if (typeof window === "undefined") return "http://127.0.0.1:8000";
    if (window.CFG_API_BASE) return window.CFG_API_BASE;
    const meta = document.querySelector('meta[name="cfg-api-base"]');
    if (meta && meta.content) return meta.content;
    if (BACKEND_URL) return BACKEND_URL;
    const proto = window.location.protocol;
    const host = window.location.hostname;
    if (!host) return "http://127.0.0.1:8000";
    return `${proto}//${host}:8000`;
}

const BASE = resolveBase().replace(/\/+$/, "");

class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

async function jsonOrThrow(res) {
    const text = await res.text();
    let body = null;
    if (text) {
        try {
            body = JSON.parse(text);
        } catch {
            body = { detail: text };
        }
    }
    if (!res.ok) {
        const detail = (body && body.detail) || res.statusText || `HTTP ${res.status}`;
        throw new ApiError(typeof detail === "string" ? detail : JSON.stringify(detail), res.status);
    }
    return body;
}

export const Api = {
    base: BASE,

    health() {
        return fetch(`${BASE}/healthz`).then(jsonOrThrow);
    },

    async upload(file, onProgress) {
        // No real progress reporting in v1 (single request); placeholder for
        // future XHR upgrade.
        if (onProgress) onProgress(0.1);
        const fd = new FormData();
        fd.append("file", file, file.name);
        const res = await fetch(`${BASE}/upload`, { method: "POST", body: fd });
        if (onProgress) onProgress(1.0);
        return jsonOrThrow(res);
    },

    getFunction(sessionId, address) {
        const url = `${BASE}/function/${encodeURIComponent(address)}?session_id=${encodeURIComponent(sessionId)}`;
        return fetch(url).then(jsonOrThrow);
    },

    getOverview(sessionId) {
        const url = `${BASE}/overview?session_id=${encodeURIComponent(sessionId)}`;
        return fetch(url).then(jsonOrThrow);
    },

    closeSession(sessionId) {
        return fetch(`${BASE}/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
            .then(jsonOrThrow)
            .catch(() => null); // best-effort
    },
};

export { ApiError };
