/**
 * app.js — top-level controller.
 *
 * Wires together the dropzone, sidebar, 3D graph, and disassembly side panel.
 * State machine:
 *   idle       → empty state shown, dropzone accepts uploads
 *   uploading  → spinner shown, dropzone disabled
 *   ready      → function list shown, graph empty
 *   viewing    → a function is selected, graph populated, status bar visible
 *   overview   → the function-overview graph is showing
 */

import { Api, ApiError } from "./api.js";
import { Graph3D } from "./graph3d.js";
import { wireDropzone } from "./uploader.js";

// --- Tiny DOM helpers ------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
    dropZone: $("dropZone"),
    fileInput: $("fileInput"),
    functionsPanel: $("functionsPanel"),
    functionList: $("functionList"),
    funcSearch: $("funcSearch"),
    funcCount: $("funcCount"),
    overviewPanel: $("overviewPanel"),
    overviewCount: $("overviewCount"),
    loadSampleBtn: $("loadSampleBtn"),
    loadSampleLink: $("loadSampleLink"),
    canvas: $("graphCanvas"),
    empty: $("empty"),
    statusBar: $("statusBar"),
    statusFunction: $("statusFunction"),
    statusNodes: $("statusNodes"),
    statusEdges: $("statusEdges"),
    legend: $("legend"),
    disasmPanel: $("disasmPanel"),
    disasmAddr: $("disasmAddr"),
    disasmType: $("disasmType"),
    disasmBody: $("disasmBody"),
    closeDisasm: $("closeDisasm"),
    toast: $("toast"),
    loading: $("loadingOverlay"),
    loadingText: $("loadingText"),
};

// --- State -----------------------------------------------------------------

const state = {
    sessionId: null,
    functions: [],
    currentView: "idle", // "idle" | "overview" | address
    graph: null,
    sampleData: null,
};

// --- UI helpers ------------------------------------------------------------

function showLoading(text) {
    els.loadingText.textContent = text || "Working...";
    els.loading.classList.remove("hidden");
}
function hideLoading() { els.loading.classList.add("hidden"); }

let toastTimer = null;
function showToast(message, kind = "info", ms = 3500) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.className = `toast show toast-${kind}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        els.toast.classList.remove("show");
    }, ms);
}

function setStatus({ function: fn, nodes, edges }) {
    if (fn !== undefined) {
        els.statusFunction.textContent = fn;
        els.statusBar.classList.remove("hidden");
        els.legend.classList.remove("hidden");
    }
    if (nodes !== undefined) els.statusNodes.textContent = `${nodes} nodes`;
    if (edges !== undefined) els.statusEdges.textContent = `${edges} edges`;
}

// --- Disassembly coloring --------------------------------------------------

function colorizeAsm(text) {
    // Light, regex-driven syntax highlight. We escape first, then wrap.
    const escape = (s) => s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    let s = escape(text);
    // Comments (Intel asm ";...")
    s = s.replace(/(;.*)$/gm, '<span class="asm-comment">$1</span>');
    // Mnemonics at line start: until first whitespace
    s = s.replace(/^(\s*)([a-zA-Z_]+)/gm, (m, ws, mn) => {
        const lower = mn.toLowerCase();
        let cls = "asm-mnemonic";
        if (lower.startsWith("j") || lower === "call" || lower === "loop") cls = "asm-jump";
        if (lower === "call") cls = "asm-call";
        if (lower === "ret" || lower === "retn" || lower === "retf" || lower === "hlt") cls = "asm-ret";
        return `${ws}<span class="${cls}">${mn}</span>`;
    });
    // Immediates (0x..., decimal after a comma)
    s = s.replace(/(0x[0-9a-fA-F]+)/g, '<span class="asm-imm">$1</span>');
    s = s.replace(/,\s*(-?\d+)\b/g, (m, n) => `, <span class="asm-imm">${n}</span>`);
    return s;
}

// --- Graph lifecycle -------------------------------------------------------

function ensureGraph() {
    if (state.graph) return state.graph;
    state.graph = new Graph3D(els.canvas);
    state.graph.onNodeClick(handleNodeClick);
    return state.graph;
}

function teardownSession() {
    if (state.sessionId) {
        Api.closeSession(state.sessionId);
        state.sessionId = null;
    }
    state.functions = [];
    els.functionList.innerHTML = "";
    els.functionsPanel.classList.add("hidden");
    els.overviewPanel.classList.add("hidden");
    els.statusBar.classList.add("hidden");
    els.legend.classList.add("hidden");
    closeDisasm();
    if (state.graph) {
        state.graph.dispose();
        state.graph = null;
    }
    state.currentView = "idle";
    els.empty.classList.remove("has-graph");
}

// --- Upload + function list -----------------------------------------------

async function handleFile(file) {
    if (!file) return;
    teardownSession();

    showLoading(`Analyzing ${file.name} (radare2 is reading the binary)...`);
    try {
        const res = await Api.upload(file);
        state.sessionId = res.session_id;
        state.functions = res.functions || [];
        if (res.warnings?.length) {
            res.warnings.forEach((w) => showToast(w, "info", 5000));
        }
        renderFunctionList(state.functions);
        showToast(`Loaded ${state.functions.length} functions from ${file.name}`, "success");
        // Default to showing the function overview if there are any.
        if (state.functions.length) {
            await showOverview();
        } else {
            showToast("No functions found in this binary.", "error", 5000);
        }
    } catch (err) {
        console.error(err);
        const msg = err instanceof ApiError ? err.message : "Upload failed";
        showToast(msg, "error", 6000);
    } finally {
        hideLoading();
    }
}

function renderFunctionList(funcs) {
    els.functionList.innerHTML = "";
    funcs.forEach((f) => {
        const li = document.createElement("li");
        li.dataset.address = f.address;
        li.dataset.name = f.name;
        li.innerHTML = `
            <span class="fn-name" title="${escapeAttr(f.name)}">${escapeHtml(f.name || "(anon)")}</span>
            <span class="fn-meta">${f.address} &middot; ${f.size}B</span>
        `;
        li.addEventListener("click", () => selectFunction(f.address));
        els.functionList.appendChild(li);
    });
    els.funcCount.textContent = funcs.length.toString();
    els.functionsPanel.classList.remove("hidden");
}

els.funcSearch.addEventListener("input", () => {
    const q = els.funcSearch.value.trim().toLowerCase();
    for (const li of els.functionList.children) {
        const name = (li.dataset.name || "").toLowerCase();
        const addr = (li.dataset.address || "").toLowerCase();
        li.style.display = !q || name.includes(q) || addr.includes(q) ? "" : "none";
    }
});

function markActiveFunction(address) {
    for (const li of els.functionList.children) {
        li.classList.toggle("active", li.dataset.address === address);
    }
}

async function selectFunction(address) {
    if (!state.sessionId) return;
    showLoading("Extracting CFG...");
    try {
        const cfg = await Api.getFunction(state.sessionId, address);
        const g = ensureGraph();
        g.setLabel(address);
        g.setData(cfg);
        setStatus({
            function: `${cfg.function || "(anon)"} @ ${address}`,
            nodes: cfg.nodes.length,
            edges: cfg.edges.length,
        });
        els.empty.classList.add("has-graph");
        state.currentView = address;
        markActiveFunction(address);
    } catch (err) {
        console.error(err);
        const msg = err instanceof ApiError ? err.message : "CFG extraction failed";
        showToast(msg, "error", 5000);
    } finally {
        hideLoading();
    }
}

async function showOverview() {
    if (!state.sessionId) return;
    showLoading("Building function overview...");
    try {
        const ov = await Api.getOverview(state.sessionId);
        const g = ensureGraph();
        g.setData(null);
        g.setOverview(ov);
        setStatus({
            function: `Binary overview (${ov.nodes.length} functions)`,
            nodes: ov.nodes.length,
            edges: ov.edges.length,
        });
        els.empty.classList.add("has-graph");
        state.currentView = "overview";
        // Show the overview panel
        els.overviewPanel.classList.remove("hidden");
        els.overviewCount.textContent = ov.nodes.length.toString();
    } catch (err) {
        console.error(err);
        const msg = err instanceof ApiError ? err.message : "Overview failed";
        showToast(msg, "error", 5000);
    } finally {
        hideLoading();
    }
}

function handleNodeClick(id, node) {
    if (state.currentView === "overview") {
        // Clicked a function node — drill into its CFG.
        selectFunction(id);
        return;
    }
    // Otherwise: show the disassembly for this block.
    showDisasm(id, node);
}

// --- Disassembly panel -----------------------------------------------------

function showDisasm(id, node) {
    els.disasmAddr.textContent = id;
    const type = (node && node.type) || "block";
    els.disasmType.textContent = type;
    const disasm = (node && node.disasm) || [];
    const body = disasm.length
        ? disasm.map((line) => colorizeAsm(line)).join("\n")
        : "<em>(empty block)</em>";
    els.disasmBody.innerHTML = body;
    els.disasmPanel.classList.remove("hidden");
    requestAnimationFrame(() => els.disasmPanel.classList.add("open"));
    els.disasmPanel.setAttribute("aria-hidden", "false");
}

function closeDisasm() {
    els.disasmPanel.classList.remove("open");
    els.disasmPanel.setAttribute("aria-hidden", "true");
    setTimeout(() => {
        // Fully hide after the slide-out so it's not in the layout
        // for hit testing.
        if (!els.disasmPanel.classList.contains("open")) {
            els.disasmPanel.classList.add("hidden");
        }
    }, 320);
}

els.closeDisasm.addEventListener("click", closeDisasm);

// --- Sample CFG (for static demo when no backend is available) -------------

async function loadSample() {
    showLoading("Loading sample CFG...");
    try {
        if (!state.sampleData) {
            const res = await fetch("samples/sample_graph.json");
            if (!res.ok) throw new Error(`Sample not found (${res.status})`);
            state.sampleData = await res.json();
        }
        teardownSession();
        const g = ensureGraph();
        g.setLabel("check_password (sample)");
        g.setData(state.sampleData);
        setStatus({
            function: `${state.sampleData.function} (sample)`,
            nodes: state.sampleData.nodes.length,
            edges: state.sampleData.edges.length,
        });
        els.empty.classList.add("has-graph");
        state.currentView = "sample";
        showToast("Loaded built-in sample CFG (no backend needed).", "info", 4000);
    } catch (err) {
        console.error(err);
        showToast("Could not load sample CFG.", "error", 5000);
    } finally {
        hideLoading();
    }
}

els.loadSampleBtn.addEventListener("click", loadSample);
els.loadSampleLink.addEventListener("click", (e) => { e.preventDefault(); loadSample(); });

// --- Wiring ----------------------------------------------------------------

wireDropzone(els.dropZone, els.fileInput, handleFile);

// Escape HTML
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function escapeAttr(s) { return escapeHtml(s); }

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        if (!els.disasmPanel.classList.contains("hidden")) closeDisasm();
    }
    if (e.key === "r" && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== "INPUT") {
        state.graph?.resetView();
    }
});

// Cleanup on unload
window.addEventListener("beforeunload", () => {
    if (state.sessionId) Api.closeSession(state.sessionId);
    state.graph?.dispose();
});

// Boot: show empty state, ready for action.
console.log("CFG Visualizer ready. Backend expected at:", Api.base);
