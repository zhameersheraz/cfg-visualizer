"""
FastAPI app for CFG Visualizer.

Endpoints
---------
POST   /upload              multipart binary upload, returns {session_id, functions: [...]}
GET    /function/{addr}     returns CFG JSON for one function in a given session
GET    /overview            returns function-level overview graph (functions-as-nodes)
DELETE /session/{sid}       tear down the r2 session and remove the temp file
GET    /healthz             liveness probe

A single global `SessionManager` keeps a dict of active sessions, each holding:
    - the temp file path on disk
    - an open R2Analyzer (lazy-initialized on first /function call)
Sessions expire after SESSION_TTL_S seconds of inactivity.
"""
from __future__ import annotations

import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from analyzer import (
    ANALYSIS_TIMEOUT_S,
    MAX_FILE_SIZE_MB,
    R2Analyzer,
    is_probably_binary,
)

logger = logging.getLogger("cfg_visualizer")

# --- Config -----------------------------------------------------------------

UPLOAD_DIR = Path(os.environ.get("CFG_UPLOAD_DIR", "/tmp/cfg-visualizer-uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

SESSION_TTL_S = int(os.environ.get("CFG_SESSION_TTL", 60 * 30))  # 30 min

CORS_ORIGINS = os.environ.get(
    "CFG_CORS_ORIGINS",
    "http://localhost:5173,http://localhost:5500,http://127.0.0.1:5500,http://localhost:8000",
).split(",")

MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024


# --- Session manager --------------------------------------------------------

class Session:
    """Holds per-upload state. Lazily opens the r2pipe session on first CFG fetch."""

    def __init__(self, session_id: str, binary_path: Path, created_at: float):
        self.session_id = session_id
        self.binary_path = binary_path
        self.created_at = created_at
        self.last_used = created_at
        self._analyzer: Optional[R2Analyzer] = None
        self._functions: Optional[List[Dict]] = None

    def touch(self) -> None:
        self.last_used = time.monotonic()

    def is_expired(self, now: float) -> bool:
        return (now - self.last_used) > SESSION_TTL_S

    def analyzer(self) -> R2Analyzer:
        if self._analyzer is None:
            self._analyzer = R2Analyzer(str(self.binary_path), timeout=ANALYSIS_TIMEOUT_S)
            self._analyzer.__enter__()
        self.touch()
        return self._analyzer

    def cached_functions(self) -> List[Dict]:
        if self._functions is None:
            a = self.analyzer()
            self._functions = [f.to_dict() for f in a.list_functions()]
        return self._functions

    def close(self) -> None:
        if self._analyzer is not None:
            try:
                self._analyzer.__exit__(None, None, None)
            except Exception:  # noqa: BLE001
                logger.warning("Error closing analyzer", exc_info=True)
            self._analyzer = None
        try:
            self.binary_path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Failed to remove %s", self.binary_path, exc_info=True)


class SessionManager:
    def __init__(self) -> None:
        self._sessions: Dict[str, Session] = {}

    def create(self, binary_path: Path) -> Session:
        sid = uuid.uuid4().hex
        s = Session(sid, binary_path, time.monotonic())
        self._sessions[sid] = s
        return s

    def get(self, sid: str) -> Session:
        s = self._sessions.get(sid)
        if s is None:
            raise HTTPException(status_code=404, detail=f"Unknown session {sid!r}")
        if s.is_expired(time.monotonic()):
            self.drop(sid)
            raise HTTPException(status_code=410, detail="Session expired")
        return s

    def drop(self, sid: str) -> None:
        s = self._sessions.pop(sid, None)
        if s is not None:
            s.close()

    def sweep(self) -> int:
        """Remove all expired sessions. Returns the number evicted."""
        now = time.monotonic()
        expired = [sid for sid, s in self._sessions.items() if s.is_expired(now)]
        for sid in expired:
            self.drop(sid)
        return len(expired)


manager = SessionManager()


# --- App --------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("CFG Visualizer backend starting. Upload dir: %s", UPLOAD_DIR)
    yield
    logger.info("Shutting down; closing %d sessions", len(manager._sessions))
    for sid in list(manager._sessions.keys()):
        manager.drop(sid)


app = FastAPI(
    title="CFG Visualizer API",
    version="0.1.0",
    description="Upload a binary, get a 3D control-flow graph back.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in CORS_ORIGINS if o.strip()],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Response models --------------------------------------------------------

class FunctionInfo(BaseModel):
    name: str
    address: str
    size: int = 0


class UploadResponse(BaseModel):
    session_id: str
    functions: List[FunctionInfo]
    warnings: List[str] = []


class OverviewNode(BaseModel):
    id: str
    name: str
    size: int = 0
    callers: int = 0
    callees: int = 0


class OverviewResponse(BaseModel):
    nodes: List[OverviewNode]
    edges: List[Dict]


# --- Endpoints --------------------------------------------------------------

@app.get("/healthz")
def healthz() -> Dict:
    return {"ok": True, "sessions": len(manager._sessions)}


@app.post("/upload", response_model=UploadResponse)
async def upload(file: UploadFile = File(...)) -> UploadResponse:
    """Accept a binary, persist it under UPLOAD_DIR, return session id + function list."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="Empty filename")

    # Save the upload to a temp file. We stream in chunks so a 200MB upload
    # doesn't materialize entirely in memory.
    suffix = Path(file.filename).suffix or ".bin"
    target = UPLOAD_DIR / f"{uuid.uuid4().hex}{suffix}"

    warnings: List[str] = []
    try:
        size = 0
        with target.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_FILE_SIZE_BYTES:
                    out.close()
                    target.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds {MAX_FILE_SIZE_MB} MB limit",
                    )
                out.write(chunk)
    finally:
        await file.close()

    if size == 0:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Empty file")

    if not is_probably_binary(target):
        target.unlink(missing_ok=True)
        raise HTTPException(
            status_code=400,
            detail=(
                "File doesn't look like an ELF/PE/Mach-O binary. "
                "Refusing to analyze."
            ),
        )

    session = manager.create(target)
    try:
        # Open r2 right away so failures surface here, not on the first /function call.
        analyzer = session.analyzer()
        funcs = [f.to_dict() for f in analyzer.list_functions()]
        session._functions = funcs
    except Exception as e:  # noqa: BLE001
        manager.drop(session.session_id)
        raise HTTPException(
            status_code=422,
            detail=f"radare2 failed to analyze the binary: {e}",
        ) from e

    if not funcs:
        warnings.append("radare2 found zero functions in this binary.")

    return UploadResponse(
        session_id=session.session_id,
        functions=[FunctionInfo(**f) for f in funcs],
        warnings=warnings,
    )


@app.get("/function/{address}")
def get_function(
    address: str,
    session_id: str = Query(..., alias="session_id"),
) -> JSONResponse:
    """Return CFG JSON for one function in the given session."""
    session = manager.get(session_id)
    try:
        analyzer = session.analyzer()
        cfg = analyzer.get_function_cfg(address)
    except LookupError:
        raise HTTPException(status_code=404, detail=f"No function at {address}")
    except TimeoutError as e:
        raise HTTPException(status_code=504, detail=str(e))
    except Exception as e:  # noqa: BLE001
        logger.exception("CFG extraction failed")
        raise HTTPException(status_code=500, detail=f"CFG extraction failed: {e}")
    return JSONResponse(cfg)


@app.get("/overview", response_model=OverviewResponse)
def overview(session_id: str = Query(..., alias="session_id")) -> OverviewResponse:
    """Return a function-level overview graph: one node per function, edges on calls."""
    session = manager.get(session_id)
    analyzer = session.analyzer()
    funcs = session.cached_functions()

    nodes: List[OverviewNode] = []
    for f in funcs:
        nodes.append(
            OverviewNode(
                id=f["address"],
                name=f["name"],
                size=int(f.get("size") or 0),
                callers=0,
                callees=0,
            )
        )

    # We rebuild call edges from radare2's `afij` output. It is cheaper to
    # query r2 once per function and accumulate than to walk the full graph.
    call_edges: List[Dict] = []
    for f in funcs:
        try:
            finfo = analyzer._cmdj(f"afij @ {f['address']}")
        except Exception:  # noqa: BLE001
            continue
        if not isinstance(finfo, list) or not finfo:
            continue
        calls = (finfo[0] or {}).get("callrefs") or []
        for c in calls:
            target_addr = c.get("addr")
            if target_addr is None:
                continue
            call_edges.append(
                {
                    "from": f["address"],
                    "to": hex(int(target_addr)),
                    "type": "call",
                }
            )

    return OverviewResponse(nodes=nodes, edges=call_edges)


@app.delete("/session/{session_id}")
def close_session(session_id: str) -> Dict:
    manager.drop(session_id)
    return {"closed": session_id}


# --- Entrypoint -------------------------------------------------------------

if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    uvicorn.run(
        "main:app",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8000")),
        reload=bool(int(os.environ.get("RELOAD", "0"))),
    )
