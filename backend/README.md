# Backend

FastAPI + `r2pipe` service that turns uploaded binaries into per-function
control-flow graphs.

## Endpoints

| Method | Path                       | What it does                                                  |
| ------ | -------------------------- | ------------------------------------------------------------- |
| GET    | `/healthz`                 | Liveness probe                                                |
| POST   | `/upload`                  | Multipart binary upload, returns `{session_id, functions[]}`  |
| GET    | `/function/{addr}`         | CFG JSON for one function (requires `?session_id=...`)        |
| GET    | `/overview`                | Function-level graph (functions-as-nodes) (requires session)  |
| DELETE | `/session/{id}`            | Tear down a session, remove the temp file                     |

## Running

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

Configurable via environment variables:

| Var                 | Default                  | Purpose                          |
| ------------------- | ------------------------ | -------------------------------- |
| `HOST`              | `127.0.0.1`              | bind address                     |
| `PORT`              | `8000`                   | listen port                      |
| `RELOAD`            | `0`                      | `1` for autoreload in dev        |
| `CFG_UPLOAD_DIR`    | `/tmp/cfg-visualizer-uploads` | where uploaded files land   |
| `CFG_SESSION_TTL`   | `1800`                   | session inactivity timeout (s)   |
| `CFG_CORS_ORIGINS`  | localhost dev ports      | comma-separated CORS allowlist   |

## Quick test

```bash
./test_api.sh /bin/ls
```

## Security note

The upload endpoint runs `radare2` against arbitrary user-supplied data.
Radare2 has had parser bugs in the past. **Do not expose this service to
the public internet** without sandboxing the r2 process (e.g. `bubblewrap`,
a seccomp profile, or a firejail). For local CTF use this is fine.
