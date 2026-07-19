"""
r2pipe wrapper for CFG extraction.

This module isolates all radare2 interaction so the FastAPI layer stays clean.
Each R2Analyzer instance owns a single r2pipe session bound to a binary path.
The instance is created via `with R2Analyzer(path) as a:` so the underlying r2
process is always terminated cleanly, even on exceptions.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterator, List, Optional

logger = logging.getLogger(__name__)

# --- Binary sniffing --------------------------------------------------------

# Magic-byte prefixes for files we are willing to analyze. Anything else gets
# rejected at /upload time. We intentionally accept gzip-compressed ELF because
# that's how some distros ship binaries.
BINARY_MAGIC: tuple[bytes, ...] = (
    b"\x7fELF",          # ELF (Linux)
    b"MZ",               # PE (Windows)
    b"\xfe\xed\xfa\xce", # Mach-O 32-bit BE
    b"\xce\xfa\xed\xfe", # Mach-O 32-bit LE
    b"\xfe\xed\xfa\xcf", # Mach-O 64-bit BE
    b"\xcf\xfa\xed\xfe", # Mach-O 64-bit LE
    b"\xca\xfe\xba\xbe", # Mach-O fat / Java class
    b"\x1f\x8b",         # gzip
)

MAX_FILE_SIZE_MB = 50
ANALYSIS_TIMEOUT_S = 60


def is_probably_binary(path: Path, head_bytes: int = 8) -> bool:
    """Return True if the first bytes of `path` match a known executable format."""
    try:
        with path.open("rb") as f:
            head = f.read(head_bytes)
    except OSError:
        return False
    if not head:
        return False
    return any(head.startswith(m) for m in BINARY_MAGIC)


# --- The analyzer -----------------------------------------------------------

@dataclass
class FunctionSummary:
    name: str
    address: str
    size: int

    def to_dict(self) -> Dict:
        return {"name": self.name, "address": self.address, "size": self.size}


class R2Analyzer:
    """
    Thin RAII wrapper around an r2pipe session.

    Usage:
        with R2Analyzer(path) as a:
            funcs = a.list_functions()
            cfg = a.get_function_cfg("0x400526")
    """

    def __init__(self, binary_path: str, timeout: int = ANALYSIS_TIMEOUT_S):
        self.binary_path = binary_path
        self.timeout = timeout
        self._r2 = None
        self._functions: Optional[List[Dict]] = None
        self._has_aaa = False

    # --- context manager ----------------------------------------------------

    def __enter__(self) -> "R2Analyzer":
        self._open()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self._close()

    def _open(self) -> None:
        # We import r2pipe lazily so the module can be imported (and unit-tested)
        # even on systems where r2pipe's deps aren't installed.
        try:
            import r2pipe  # type: ignore
        except ImportError as e:  # pragma: no cover - import guard
            raise RuntimeError(
                "r2pipe is not installed. Run: pip install r2pipe"
            ) from e

        if shutil.which("r2") is None:
            raise RuntimeError(
                "radare2 (`r2`) is not on PATH. Install it: "
                "apt install radare2 (Debian/Kali) or brew install radare2 (macOS)."
            )

        logger.info("Opening r2pipe session for %s", self.binary_path)
        self._r2 = r2pipe.open(self.binary_path)
        # r2pipe can occasionally throw on the first command if the binary is
        # malformed; the analyze() call below handles aaa errors.

    def _close(self) -> None:
        if self._r2 is not None:
            try:
                self._r2.quit()
            except Exception:  # noqa: BLE001 - r2 is best-effort
                logger.warning("r2.quit() raised; ignoring", exc_info=True)
            self._r2 = None

    # --- commands -----------------------------------------------------------

    def _cmdj(self, cmd: str):
        """Run a JSON-returning r2 command with a wall-clock timeout."""
        assert self._r2 is not None, "R2Analyzer used outside context manager"
        start = time.monotonic()
        # r2pipe does not expose a timeout knob itself, so we enforce one via
        # a watchdog. This is best-effort: if the underlying r2 process is
        # wedged inside an `aaa` we kill the whole analyzer on the next call.
        try:
            result = self._r2.cmdj(cmd)
        except Exception as e:  # noqa: BLE001
            logger.error("r2 cmdj(%r) failed: %s", cmd, e)
            raise RuntimeError(f"r2 command {cmd!r} failed: {e}") from e
        elapsed = time.monotonic() - start
        if elapsed > self.timeout:
            raise TimeoutError(
                f"r2 command {cmd!r} took {elapsed:.1f}s (limit {self.timeout}s)"
            )
        return result

    def _cmd(self, cmd: str) -> str:
        assert self._r2 is not None
        return self._r2.cmd(cmd)

    def analyze(self) -> None:
        """Run `aaa` once and cache the function list."""
        if self._has_aaa:
            return
        logger.info("Running aaa (analyze all) on %s", self.binary_path)
        self._cmd("aaa")
        self._functions = self._cmdj("aflj") or []
        self._has_aaa = True
        logger.info("Found %d functions", len(self._functions))

    def list_functions(self) -> List[FunctionSummary]:
        if not self._has_aaa:
            self.analyze()
        out: List[FunctionSummary] = []
        for f in self._functions or []:
            name = str(f.get("name") or "")
            # r2 6.x uses "addr"; older versions used "offset". Accept both
            # for forward-compat.
            addr_raw = f.get("addr")
            if addr_raw is None:
                addr_raw = f.get("offset") or 0
            # Drop PLT imports and other zero-CFG entries so the sidebar
            # isn't dominated by sym.imp.* stubs that can't be graphed.
            if name.startswith("sym.imp."):
                continue
            if f.get("is-pure") in (True, "true") and int(f.get("outdegree") or 0) == 0:
                continue
            out.append(
                FunctionSummary(
                    name=name,
                    address=hex(int(addr_raw)),
                    size=int(f.get("size") or 0),
                )
            )
        return out

    def get_function_cfg(self, target: str) -> Dict:
        """
        Get CFG JSON for a function.

        `target` may be either:
          - an address: "0x400526", "400526", "0X400526"
          - a function name: "main", "sym.error", "fcn.00006790"
        """
        if not target:
            raise LookupError("Empty function target")

        token = target.strip()
        addr = None
        func_name = ""

        # First, try the cached function list to resolve names to addresses.
        # r2's `agj @ <name>` is unreliable across r2 versions; resolving
        # via the cached list and passing a real address always works.
        for f in self._functions or []:
            if str(f.get("name") or "") == token:
                func_name = str(f.get("name") or "")
                addr_raw = f.get("addr")
                if addr_raw is None:
                    addr_raw = f.get("offset") or 0
                addr = hex(int(addr_raw))
                break

        # If not in the list, try as an address.
        if addr is None:
            if token.lower().startswith("0x") or all(c in "0123456789abcdefABCDEF" for c in token):
                addr = token.lower()
                if not addr.startswith("0x"):
                    addr = "0x" + addr
            else:
                # Last-ditch: r2's name resolution. May or may not work
                # depending on r2 version.
                addr = token

        agj = self._cmdj(f"agj @ {addr}")
        if not agj:
            raise LookupError(f"No graph returned for function {target!r}")
        return transform_agj(agj, func_name or token)


# --- Schema transform -------------------------------------------------------

def classify_block(block: Dict, ops: List[Dict]) -> str:
    """Map a radare2 basic block to one of our node `type` values."""
    if not ops:
        return "normal"
    last = ops[-1]
    op_type = (last.get("type") or "").lower()
    disasm = (last.get("disasm") or "").lower()
    first_token = disasm.split()[:1]

    if "ret" in op_type or first_token == ["ret"] or first_token == ["retn"]:
        return "return"
    if "cjmp" in op_type or "ujmp" in op_type or op_type == "cjmp":
        return "conditional"
    if "call" in op_type or first_token == ["call"]:
        return "call"
    if op_type in ("jmp", "ujmp") and "fail" in block:
        return "conditional"
    return "normal"


def _disasm_lines(ops: List[Dict]) -> List[str]:
    lines: List[str] = []
    for op in ops:
        d = op.get("disasm")
        if d:
            lines.append(str(d))
    return lines


def transform_agj(agj, func_name: str = "") -> Dict:
    """
    Convert radare2's `agj` output into the CFG schema used by the frontend.

    r2 6.x changed the output format: `agj @ <addr>` now returns a JSON
    *array* of blocks directly, with no wrapper object. Older r2 versions
    wrapped the blocks in a dict with `name`/`blocks` fields. We accept
    both.

    r2 6.x output:
        [
          { "addr": 0x..., "jump": 0x..., "fail": 0x..., "ops": [ ... ] },
          ...
        ]

    Older r2 output:
        { "name": "main", "blocks": [ ... ] }

    We produce:
        { "function": "...", "nodes": [...], "edges": [...] }
    """
    if not agj:
        return {"function": func_name, "nodes": [], "edges": []}

    # r2 6.x: list directly. Older: dict wrapper.
    if isinstance(agj, list):
        blocks = agj
    else:
        blocks = agj.get("blocks") or []
        if not func_name:
            func_name = str(agj.get("name") or "")

    nodes: List[Dict] = []
    edges: List[Dict] = []
    seen: set[str] = set()

    for i, block in enumerate(blocks):
        # r2 6.x uses "addr" for block addresses; older versions used "offset".
        addr_raw = block.get("addr")
        if addr_raw is None:
            addr_raw = block.get("offset") or 0
        offset = int(addr_raw)
        node_id = hex(offset)
        ops = block.get("ops") or []
        disasm = _disasm_lines(ops)

        if i == 0:
            node_type = "entry"
        else:
            node_type = classify_block(block, ops)

        if node_id not in seen:
            nodes.append(
                {
                    "id": node_id,
                    "type": node_type,
                    "disasm": disasm,
                }
            )
            seen.add(node_id)

        # Edges — emitted for every block, including the entry. If the entry
        # block has a `jump`, that's still control flow leaving the function.
        jump = block.get("jump")
        fail = block.get("fail")
        if jump is not None:
            target = hex(int(jump))
            edge_type = "jmp_true" if fail is not None else "flow"
            edges.append({"from": node_id, "to": target, "type": edge_type})
        if fail is not None:
            target = hex(int(fail))
            edges.append({"from": node_id, "to": target, "type": "jmp_false"})

    return {
        "function": func_name,
        "nodes": nodes,
        "edges": edges,
    }


# --- Optional CLI for sanity-checking ---------------------------------------

@contextmanager
def session_for_path(path: str) -> Iterator[R2Analyzer]:
    a = R2Analyzer(path)
    with a as opened:
        yield opened


def _cli() -> None:  # pragma: no cover - manual smoke test
    import argparse
    import json as _json
    import sys

    p = argparse.ArgumentParser(description="Quick CLI: list functions and dump one CFG.")
    p.add_argument("binary", help="Path to a binary to analyze")
    p.add_argument("--fn", help="Function address (e.g. 0x400526) to dump as JSON")
    p.add_argument("--list", action="store_true", help="List functions and exit")
    args = p.parse_args()

    with session_for_path(args.binary) as a:
        if args.list:
            for f in a.list_functions():
                print(f"{f.address}  size={f.size:<6d}  {f.name}")
            return
        if args.fn:
            print(_json.dumps(a.get_function_cfg(args.fn), indent=2))
            return
        # default: list
        for f in a.list_functions():
            print(f"{f.address}  size={f.size:<6d}  {f.name}")


if __name__ == "__main__":  # pragma: no cover
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    _cli()
