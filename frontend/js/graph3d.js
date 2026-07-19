/**
 * graph3d.js — Three.js renderer for control-flow and overview graphs.
 *
 * Public surface:
 *   const g = new Graph3D(canvas);
 *   g.setData(cfgJson);              // per-function CFG (nodes/edges) OR
 *   g.setOverview(overviewJson);     // functions-as-nodes graph
 *   g.setLabel("function name");
 *   g.onNodeClick(cb);
 *   g.flyToNode(id);
 *   g.resetView();
 *   g.dispose();
 *
 * Layout: d3-force-3d settles node positions in 3D, then we hand the
 * positions to Three.js meshes. We never re-run the simulation after the
 * first settle — interactions are pure camera + highlight.
 *
 * Visual style: dark, NOCTURNE. Nodes are spheres with a subtle inner glow
 * sprite. Edges are thin lines color-coded by edge type. A faint starfield
 * sits behind the graph to make empty space feel intentional, not flat.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const NODE_COLORS = {
    entry:        new THREE.Color("#4a9eff"),
    normal:       new THREE.Color("#6a7a8a"),
    conditional:  new THREE.Color("#f0a040"),
    call:         new THREE.Color("#b366ff"),
    return:       new THREE.Color("#ff5577"),
    overview:     new THREE.Color("#4a9eff"),
    overview_used:new THREE.Color("#2c6db5"),
};

const EDGE_COLORS = {
    flow:      new THREE.Color("#4a9eff"),
    jmp_true:  new THREE.Color("#4ade80"),
    jmp_false: new THREE.Color("#f87171"),
    call:      new THREE.Color("#b366ff"),
};

function colorFor(type, map) {
    return map[type] || map.normal || new THREE.Color("#888888");
}

export class Graph3D {
    constructor(canvas) {
        this.canvas = canvas;
        this._disposed = false;
        this._onNodeClick = null;
        this._data = null;
        this._mode = "cfg"; // "cfg" | "overview"
        this._label = "";

        this._initScene();
        this._initInteraction();
        this._animate = this._animate.bind(this);
        requestAnimationFrame(this._animate);

        window.addEventListener("resize", this._onResize = () => this._resize());
    }

    // ------------------------------------------------------------------
    // Setup
    // ------------------------------------------------------------------

    _initScene() {
        const { canvas } = this;

        this.scene = new THREE.Scene();
        this.scene.background = null; // CSS background shows through
        this.scene.fog = new THREE.Fog(0x050810, 60, 200);

        const w = canvas.clientWidth || canvas.parentElement.clientWidth || window.innerWidth;
        const h = canvas.clientHeight || canvas.parentElement.clientHeight || window.innerHeight;

        this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
        this.camera.position.set(0, 12, 38);
        this.camera.lookAt(0, 0, 0);

        this.renderer = new THREE.WebGLRenderer({
            canvas,
            antialias: true,
            alpha: true,
            powerPreference: "high-performance",
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(w, h, false);

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.minDistance = 4;
        this.controls.maxDistance = 120;
        this.controls.target.set(0, 0, 0);

        // Lighting — subtle, mostly for the sphere highlights.
        const ambient = new THREE.AmbientLight(0xffffff, 0.45);
        this.scene.add(ambient);
        const key = new THREE.DirectionalLight(0x88aaff, 0.7);
        key.position.set(8, 18, 12);
        this.scene.add(key);
        const rim = new THREE.DirectionalLight(0xff8888, 0.25);
        rim.position.set(-12, -8, -10);
        this.scene.add(rim);

        // Faint starfield — three.js Points at random positions in a shell.
        this._buildStarfield();

        this._root = new THREE.Group();
        this.scene.add(this._root);

        this._raycaster = new THREE.Raycaster();
        this._raycaster.params.Line = { threshold: 0.5 };
        this._pointer = new THREE.Vector2();
        this._hovered = null;

        this._resize();
    }

    _initInteraction() {
        this.canvas.addEventListener("pointermove", this._onMove = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        });
        this.canvas.addEventListener("click", this._onClick = () => this._handleClick());
    }

    _buildStarfield() {
        const N = 600;
        const positions = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            // shell around origin
            const r = 80 + Math.random() * 100;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
            positions[i * 3 + 2] = r * Math.cos(phi);
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.PointsMaterial({
            color: 0x4a5a7a,
            size: 0.6,
            sizeAttenuation: true,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
        });
        this._stars = new THREE.Points(geom, mat);
        this.scene.add(this._stars);
    }

    _resize() {
        const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth || 1;
        const h = this.canvas.clientHeight || this.canvas.parentElement.clientHeight || 1;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    _onResize() { this._resize(); }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    setLabel(label) { this._label = label || ""; }

    onNodeClick(cb) { this._onNodeClick = cb; }

    setData(cfg) {
        this._clearRoot();
        this._mode = "cfg";
        this._data = cfg;
        if (!cfg || !cfg.nodes || !cfg.nodes.length) return;
        this._buildGraph(cfg.nodes, cfg.edges, /* isOverview */ false);
        this._frameGraph();
    }

    setOverview(overview) {
        this._clearRoot();
        this._mode = "overview";
        this._data = overview;
        if (!overview || !overview.nodes || !overview.nodes.length) return;
        // In overview mode, edges are 'call' edges between functions.
        this._buildGraph(overview.nodes, overview.edges, /* isOverview */ true);
        this._frameGraph();
    }

    flyToNode(id) {
        if (!this._nodeById) return;
        const node = this._nodeById.get(id);
        if (!node) return;
        const pos = node.group.position;
        const offset = new THREE.Vector3(8, 6, 12);

        // GSAP is loaded globally on window.
        if (window.gsap) {
            window.gsap.to(this.camera.position, {
                x: pos.x + offset.x,
                y: pos.y + offset.y,
                z: pos.z + offset.z,
                duration: 1.2,
                ease: "power2.inOut",
                onUpdate: () => {
                    this.camera.lookAt(pos);
                    this.controls.target.copy(pos);
                },
            });
            window.gsap.to(this.controls.target, {
                x: pos.x, y: pos.y, z: pos.z,
                duration: 1.2, ease: "power2.inOut",
            });
        } else {
            this.camera.position.set(pos.x + offset.x, pos.y + offset.y, pos.z + offset.z);
            this.controls.target.copy(pos);
            this.camera.lookAt(pos);
        }
        this._highlightNode(id);
    }

    resetView() {
        if (window.gsap) {
            window.gsap.to(this.camera.position, {
                x: 0, y: 12, z: 38, duration: 0.8, ease: "power2.inOut",
            });
            window.gsap.to(this.controls.target, {
                x: 0, y: 0, z: 0, duration: 0.8, ease: "power2.inOut",
            });
        } else {
            this.camera.position.set(0, 12, 38);
            this.controls.target.set(0, 0, 0);
        }
        this._clearHighlight();
    }

    dispose() {
        if (this._disposed) return;
        this._disposed = true;
        this._clearRoot();
        if (this._stars) {
            this._stars.geometry.dispose();
            this._stars.material.dispose();
            this.scene.remove(this._stars);
        }
        this.renderer.dispose();
        window.removeEventListener("resize", this._onResize);
        this.canvas.removeEventListener("pointermove", this._onMove);
        this.canvas.removeEventListener("click", this._onClick);
    }

    // ------------------------------------------------------------------
    // Graph construction
    // ------------------------------------------------------------------

    _clearRoot() {
        while (this._root.children.length) {
            const c = this._root.children[0];
            this._root.remove(c);
            c.traverse?.((o) => {
                o.geometry?.dispose?.();
                if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
                else o.material?.dispose?.();
            });
        }
        this._nodeById = new Map();
        this._edgeById = new Map();
        this._highlighted = null;
    }

    _buildGraph(nodes, edges, isOverview) {
        // d3-force-3d runs in window scope (UMD bundle).
        const d3f = window.d3 || window.d3Force3d;
        if (!d3f || !d3f.forceSimulation) {
            // Fallback: place nodes on a circle. Layout still readable.
            this._layoutCircle(nodes);
        } else {
            try {
                this._layoutForce(nodes, edges, d3f);
            } catch (err) {
                // If d3-force-3d throws (older bundle, different shape, NaN
                // coords from a degenerate graph), fall back to a circle layout
                // so the user still sees *something* rather than an empty canvas.
                console.warn("d3-force-3d layout failed, using circle fallback:", err);
                // Strip any partial __pos that may have been written.
                nodes.forEach((n) => { delete n.__pos; });
                this._layoutCircle(nodes);
            }
        }

        // Edges first so nodes draw over them.
        this._buildEdges(edges || [], isOverview);
        this._buildNodes(nodes, isOverview);
    }

    _layoutCircle(nodes) {
        const r = Math.max(8, nodes.length * 0.8);
        nodes.forEach((n, i) => {
            const a = (i / nodes.length) * Math.PI * 2;
            n.__pos = [Math.cos(a) * r, 0, Math.sin(a) * r];
        });
    }

    _layoutForce(nodes, edges, d3f) {
        // d3-force-3d works on plain objects with x/y/z; we attach __pos
        // (a Float64Array-friendly tuple) at the end.
        const simNodes = nodes.map((n) => ({ id: n.id, ref: n }));
        const simLinks = (edges || [])
            .filter((e) => nodes.find((n) => n.id === e.from) && nodes.find((n) => n.id === e.to))
            .map((e) => ({ source: e.from, target: e.to }));

        const sim = d3f.forceSimulation(simNodes)
            .force(
                "link",
                d3f.forceLink(simLinks)
                    .id((d) => d.id)
                    .distance(8)
                    .strength(0.5)
            )
            .force("charge", d3f.forceManyBody().strength(-60))
            .force("center", d3f.forceCenter(0, 0, 0));

        // Run the simulation synchronously to a steady state. d3's "tick" is
        // async-friendly, but for static embedding we can step it ourselves.
        for (let i = 0; i < 200; i++) sim.tick();
        sim.stop();

        for (const n of simNodes) {
            n.ref.__pos = [n.x || 0, n.y || 0, n.z || 0];
        }
    }

    _buildNodes(nodes, isOverview) {
        for (const n of nodes) {
            const pos = n.__pos || [0, 0, 0];
            const type = n.type || "normal";
            const color = isOverview
                ? (n.id === this._label ? NODE_COLORS.overview_used : NODE_COLORS.overview)
                : colorFor(type, NODE_COLORS);

            const group = new THREE.Group();
            group.position.set(pos[0], pos[1], pos[2]);

            // Core sphere
            const radius = isOverview ? 0.9 : 0.75;
            const sphereGeom = new THREE.SphereGeometry(radius, 24, 18);
            const sphereMat = new THREE.MeshStandardMaterial({
                color,
                emissive: color,
                emissiveIntensity: 0.45,
                metalness: 0.25,
                roughness: 0.4,
            });
            const sphere = new THREE.Mesh(sphereGeom, sphereMat);
            group.add(sphere);

            // Soft glow shell (additive blending, no depth write).
            const glowGeom = new THREE.SphereGeometry(radius * 1.7, 16, 12);
            const glowMat = new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.12,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
            });
            const glow = new THREE.Mesh(glowGeom, glowMat);
            group.add(glow);

            // For conditional nodes, add a thin ring around the sphere.
            if (!isOverview && type === "conditional") {
                const ringGeom = new THREE.RingGeometry(radius * 1.5, radius * 1.7, 32);
                const ringMat = new THREE.MeshBasicMaterial({
                    color,
                    side: THREE.DoubleSide,
                    transparent: true,
                    opacity: 0.4,
                    depthWrite: false,
                });
                const ring = new THREE.Mesh(ringGeom, ringMat);
                ring.lookAt(this.camera.position);
                group.add(ring);
            }

            group.userData = { id: n.id, node: n, isOverview };
            this._root.add(group);
            this._nodeById.set(n.id, group);
        }
    }

    _buildEdges(edges, isOverview) {
        if (!edges || !edges.length) return;
        // One BufferGeometry for all edges, with per-vertex color.
        const positions = [];
        const colors = [];

        for (const e of edges) {
            const from = this._nodeById.get(e.from);
            const to = this._nodeById.get(e.to);
            if (!from || !to) continue;
            const a = from.position;
            const b = to.position;
            // Use a slightly curved line via two-segment polyline (subtle bow).
            const mid = a.clone().add(b).multiplyScalar(0.5);
            const offset = new THREE.Vector3(0, 1.5, 0);
            const c = mid.clone().add(offset);

            positions.push(a.x, a.y, a.z, c.x, c.y, c.z, c.x, c.y, c.z, b.x, b.y, b.z);

            const color = isOverview
                ? (EDGE_COLORS.call || EDGE_COLORS.flow)
                : (EDGE_COLORS[e.type] || EDGE_COLORS.flow);
            for (let i = 0; i < 4; i++) {
                colors.push(color.r, color.g, color.b);
            }
        }

        if (!positions.length) return;

        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));

        const mat = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
        });
        const lines = new THREE.LineSegments(geom, mat);
        this._root.add(lines);
        this._edgeLine = lines;
    }

    _frameGraph() {
        // Compute bounding box of root, then place camera so it fits.
        if (!this._root.children.length) return;
        const box = new THREE.Box3().setFromObject(this._root);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        const maxDim = Math.max(size.x, size.y, size.z) || 10;
        const fov = this.camera.fov * (Math.PI / 180);
        let distance = (maxDim / 2) / Math.tan(fov / 2);
        distance *= 1.7; // padding

        this.camera.position.set(center.x, center.y + size.y * 0.3, center.z + distance);
        this.controls.target.copy(center);
        this.camera.lookAt(center);
        this.camera.updateProjectionMatrix();
    }

    // ------------------------------------------------------------------
    // Interaction
    // ------------------------------------------------------------------

    _handleClick() {
        if (!this._nodeById || this._nodeById.size === 0) return;
        this._raycaster.setFromCamera(this._pointer, this.camera);
        const meshes = [];
        for (const g of this._nodeById.values()) {
            g.children.forEach((c) => {
                if (c.isMesh) meshes.push(c);
            });
        }
        const hits = this._raycaster.intersectObjects(meshes, false);
        if (hits.length) {
            // Walk up to the node group.
            let obj = hits[0].object;
            while (obj && !obj.userData?.id) obj = obj.parent;
            if (obj && obj.userData?.id) {
                this._highlightNode(obj.userData.id);
                this.flyToNode(obj.userData.id);
                if (this._onNodeClick) this._onNodeClick(obj.userData.id, obj.userData.node);
            }
        }
    }

    _highlightNode(id) {
        if (this._highlighted === id) return;
        this._clearHighlight();
        const group = this._nodeById.get(id);
        if (!group) return;
        this._highlighted = id;
        // Scale up slightly + boost emissive.
        group.children.forEach((c) => {
            if (c.isMesh) {
                c.userData._origScale = c.scale.clone();
                c.userData._origEmissive = c.material.emissiveIntensity;
                c.scale.multiplyScalar(1.25);
                if ("emissiveIntensity" in c.material) {
                    c.material.emissiveIntensity = 0.9;
                }
            }
        });
    }

    _clearHighlight() {
        if (!this._highlighted) return;
        const group = this._nodeById.get(this._highlighted);
        if (group) {
            group.children.forEach((c) => {
                if (c.isMesh) {
                    if (c.userData._origScale) c.scale.copy(c.userData._origScale);
                    if (c.userData._origEmissive !== undefined) {
                        c.material.emissiveIntensity = c.userData._origEmissive;
                    }
                }
            });
        }
        this._highlighted = null;
    }

    // ------------------------------------------------------------------
    // Loop
    // ------------------------------------------------------------------

    _animate() {
        if (this._disposed) return;
        requestAnimationFrame(this._animate);

        // Subtle star rotation to give the void some life.
        if (this._stars) this._stars.rotation.y += 0.00015;

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}
