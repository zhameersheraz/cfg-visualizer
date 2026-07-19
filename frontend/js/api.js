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

const explicitBase = (typeof window !== "undefined" && window.CFG_API_BASE) || null;
const defaultBase =
    typeof window !== "undefined" && window.location
        ? `${window.location.protocol}//${window.location.hostname}:8000`
        : "http://127.0.0.1:8000";

const BASE = (explicitBase || defaultBase).replace(/\/+$/, "");

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
