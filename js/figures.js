// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Static article figures: renders precomputed SoA JSON layouts (the
 * `.morpho-layout` blocks in article.md) via a shared offscreen LayoutRenderer,
 * with Canvas 2D overlays for the resolved-bits indicator.
 */

import {
    CELL_STYLES,
    TIMING_CONFIG,
    LayoutRenderer,
    writeNodeSlot,
    writeLinkSlot,
    createLegendOverlay
} from './layout_renderer.js';

let sharedRenderer = null;
function getSharedRenderer() {
    if (!sharedRenderer) {
        const offscreenCanvas = document.createElement('canvas');
        sharedRenderer = new LayoutRenderer(offscreenCanvas);
    }
    return sharedRenderer;
}

function hexToRgb(hex) {
    let h = hex.replace(/^#/, '');
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    const num = parseInt(h, 16);
    return isNaN(num) ? null : [num >> 16, (num >> 8) & 255, num & 255];
}

function getNodeProgress(t, depth, maxD, animate) {
    if (!animate) return 1.0;
    if (t < 0.0) {
        return Math.min(1.0, Math.max(0.0, -t / TIMING_CONFIG.fadeDuration));
    }
    const Tp = maxD * TIMING_CONFIG.defaultTStep;
    if (t < Tp) {
        return Math.min(1.0, Math.max(0.0, (t - depth * TIMING_CONFIG.defaultTStep) / TIMING_CONFIG.pulseDuration));
    }
    return 1.0;
}

export function renderLayout(container, data, options = {}) {
    let canvas = container.querySelector('canvas');
    if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.style.display = 'block';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        container.appendChild(canvas);
    }
    const ctx = canvas.getContext('2d');
    let animationFrameId = null;
    let isDrawing = true;
    let isVisible = false;

    const opts = typeof options === 'boolean' ? { animate: options } : options;
    const animate = opts.animate !== false;
    const nodeSize = opts.nodeSize !== undefined ? opts.nodeSize : 0.5;
    const tStep = opts.tStep !== undefined ? opts.tStep : 0.45;

    const { x, y, labels, unique_labels, edges } = data;
    if (!x || x.length === 0) return () => {};

    createLegendOverlay(container, data, opts.colorByDepth === true);

    // 1. Precompute node depth topologically
    const numNodes = x.length;
    const adj = Array.from({ length: numNodes }, () => []);
    const inDegree = new Int32Array(numNodes);
    for (let i = 0; i < edges.length; i += 2) {
        const u = edges[i], v = edges[i + 1];
        adj[u].push(v);
        inDegree[v]++;
    }

    const depth = new Int32Array(numNodes);
    const queue = [];
    for (let i = 0; i < numNodes; i++) {
        const l = unique_labels[labels[i]];
        if (l.startsWith('in:') || inDegree[i] === 0) {
            queue.push(i);
            depth[i] = 0;
        } else {
            depth[i] = -1;
        }
    }

    let maxDepth = 0, head = 0;
    while (head < queue.length) {
        const u = queue[head++];
        const cur = depth[u];
        for (const v of adj[u]) {
            if (depth[v] < cur + 1) {
                depth[v] = cur + 1;
                maxDepth = Math.max(maxDepth, depth[v]);
                queue.push(v);
            }
        }
    }

    // 1b. Collect output nodes if resolved bits indicator is requested
    const showResolvedBits = opts.showResolvedBits === true;
    const outputNodes = [];
    if (showResolvedBits) {
        for (let i = 0; i < numNodes; i++) {
            const l = unique_labels[labels[i]];
            if (l.startsWith('out:')) {
                const clean = l.slice(4);
                const isCarry = clean.startsWith('c_out') || clean.startsWith('carry');
                const match = clean.match(/\[(\d+)\]/);
                outputNodes.push({
                    depth: depth[i],
                    bitIdx: isCarry ? 9999 : (match ? parseInt(match[1], 10) : 0),
                    isCarry
                });
            }
        }
        outputNodes.sort((a, b) => a.bitIdx - b.bitIdx);
    }

    // 2. Pre-process unique label RGB styles
    const labelStyles = unique_labels.map(l => {
        if (l.startsWith('in:')) return [0.0, 0.898, 1.0];
        if (l.startsWith('out:')) return [1.0, 0.0, 0.333];
        return (CELL_STYLES[l] || { rgb: [1.0, 0.4, 0.0] }).rgb;
    });

    const nodeMaskColors = new Array(numNodes).fill(null);
    if (opts.masks && opts.masks.length > 0) {
        const maskColors = opts.maskColors || [];
        opts.masks.forEach((maskIndices, idx) => {
            const rgb = hexToRgb(maskColors[idx] || '#ff0000');
            if (rgb) {
                const normRgb = [rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0];
                maskIndices.forEach(nodeIdx => {
                    if (nodeIdx >= 0 && nodeIdx < numNodes) nodeMaskColors[nodeIdx] = normRgb;
                });
            }
        });
    }

    // 3. Precompute layout bounds once outside render loop
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < x.length; i++) {
        xMin = Math.min(xMin, x[i]);
        xMax = Math.max(xMax, x[i]);
        yMin = Math.min(yMin, y[i]);
        yMax = Math.max(yMax, y[i]);
    }
    const dx = xMax - xMin, dy = yMax - yMin;
    const T_propagate = maxDepth * tStep;
    const T_cycle = T_propagate + TIMING_CONFIG.pauseDuration + TIMING_CONFIG.fadeDuration;
    const linkCount = edges.length / 2;

    // 4. Flat SoA buffers for node colors, sizes, and symbols
    const colorByDepth = opts.colorByDepth === true;
    const bufIdx = unique_labels.indexOf('BUF');

    const nodeRows = Math.ceil((numNodes * 3) / 256);
    const nodeRowsPadded = Math.ceil(nodeRows / 16) * 16;
    const staticNodesBuffer = new Float32Array(256 * nodeRowsPadded * 4);

    for (let i = 0; i < numNodes; i++) {
        const labelIdx = labels[i];
        const r = labelIdx === bufIdx ? nodeSize * 0.55 : nodeSize;

        let rgb = nodeMaskColors[i] || labelStyles[labelIdx];
        if (!nodeMaskColors[i] && colorByDepth) {
            const ratio = depth[i] / (maxDepth || 1);
            rgb = [ratio, 0.898 * (1.0 - ratio), 1.0 - ratio * 0.667];
        }

        const l = unique_labels[labelIdx];
        let charCode = 0;
        if (l.startsWith('in:')) charCode = 73;
        else if (l.startsWith('out:')) charCode = 79;
        else if (CELL_STYLES[l] && CELL_STYLES[l].label) charCode = CELL_STYLES[l].label.charCodeAt(0);

        writeNodeSlot(staticNodesBuffer, i, x[i], y[i], r, 1.0, rgb, depth[i], charCode, 1.0);
    }

    const linkRows = Math.ceil((linkCount * 2) / 256);
    const linkRowsPadded = Math.ceil(linkRows / 16) * 16;
    const staticLinksBuffer = new Float32Array(256 * linkRowsPadded * 4);

    for (let i = 0; i < edges.length; i += 2) {
        const u = edges[i], v = edges[i + 1];
        writeLinkSlot(staticLinksBuffer, i / 2, x[u], y[u], x[v], y[v], depth[u], depth[v], 1.0);
    }

    const plotId = Math.random().toString(36).substring(2, 9);

    const draw = () => {
        if (!isDrawing || (animate && !isVisible)) return;
        if (window.figuresPaused) {
            if (animate) animationFrameId = requestAnimationFrame(draw);
            return;
        }

        const dpr = window.devicePixelRatio || 1;
        const rect = container.getBoundingClientRect();
        const W = rect.width, H = rect.height;
        if (W === 0 || H === 0) {
            if (animate) animationFrameId = requestAnimationFrame(draw);
            return;
        }

        const physW = Math.round(W * dpr);
        const physH = Math.round(H * dpr);
        if (canvas.width !== physW || canvas.height !== physH) {
            canvas.width = physW;
            canvas.height = physH;
        }

        const padding = 24;
        const bottomReserve = (showResolvedBits && outputNodes.length > 0) ? 32 : 0;
        const W_fit = W - 2 * padding, H_fit = H - 2 * padding - bottomReserve;

        const rotate = Math.min(W_fit / (dy || 1), H_fit / (dx || 1)) > Math.min(W_fit / (dx || 1), H_fit / (dy || 1));
        const fdx = rotate ? dy : dx, fdy = rotate ? dx : dy;
        const cx = rotate ? -(yMin + yMax) / 2 : (xMin + xMax) / 2;
        const cy = rotate ? (xMin + xMax) / 2 : (yMin + yMax) / 2;

        const scale = Math.min(W_fit / (fdx || 1), H_fit / (fdy || 1));
        const cycleTime = (performance.now() * 0.001) % T_cycle;
        const t = animate ? cycleTime - (TIMING_CONFIG.pauseDuration + TIMING_CONFIG.fadeDuration) : 0;

        try {
            const renderer = getSharedRenderer();
            renderer.render({
                width: W,
                height: H,
                dpr: dpr,
                panX: -cx * scale,
                panY: -cy * scale - (bottomReserve / 2),
                zoom: scale / 16.0,
                rotate: rotate,
                simTime: t,
                simActive: animate,
                maxDepth: maxDepth,
                tStep: tStep,
                colorEdgesByDepth: opts.colorByDepth,
                id: plotId,
                nodesData: staticNodesBuffer,
                nodeCount: numNodes,
                linksData: staticLinksBuffer,
                linkCount: linkCount
            });

            ctx.resetTransform();
            ctx.clearRect(0, 0, physW, physH);
            const maxH = renderer.canvas.height;
            ctx.drawImage(renderer.canvas, 0, maxH - physH, physW, physH, 0, 0, physW, physH);

            const fallbackImg = container.querySelector('.layout-fallback');
            if (fallbackImg && fallbackImg.style.display !== 'none') {
                fallbackImg.style.display = 'none';
            }
        } catch (e) {
            console.warn("WebGL rendering failed, preserving static fallback image:", e);
            isDrawing = false;
            if (canvas && canvas.parentNode) canvas.style.display = 'none';
            return;
        }

        if (showResolvedBits && outputNodes.length > 0) {
            ctx.save();
            ctx.scale(dpr, dpr);
            const yInd = H - 10, yLab = H - 24;
            ctx.font = 'bold 11px SFMono-Regular, Consolas, Menlo, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.fillText("RESOLVED BITS", W / 2, yLab);

            const M = outputNodes.length;
            const hasCarry = outputNodes.some(n => n.isCarry);
            const maxW = W - 32;
            const spacing = Math.min(8, maxW / (hasCarry ? M + 2.0 : M || 1));
            const totW = hasCarry ? (M - 2) * spacing + spacing * 2.0 : (M - 1) * spacing;
            const startX = (W - totW) / 2;

            for (let k = 0; k < M; k++) {
                const outItem = outputNodes[k];
                const xCircle = (hasCarry && k === M - 1)
                    ? startX + (k - 1) * spacing + spacing * 3.0
                    : startX + k * spacing;

                const progress = getNodeProgress(t, outItem.depth, maxDepth, animate);

                ctx.beginPath();
                ctx.arc(xCircle, yInd, 4.0, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(255, 0, 85, ${0.8 * progress})`;
                ctx.fill();

                ctx.beginPath();
                ctx.arc(xCircle, yInd, 1.8, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(255, 0, 85, ${0.6 + 0.4 * progress})`;
                ctx.fill();

                if (outItem.isCarry) {
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
                    ctx.fillText("CARRY", xCircle, yLab);
                }
            }
            ctx.restore();
        }

        if (animate) {
            animationFrameId = requestAnimationFrame(draw);
        }
    };

    if (animate) {
        const startLoop = () => {
            if (isDrawing && isVisible) {
                if (animationFrameId) cancelAnimationFrame(animationFrameId);
                animationFrameId = requestAnimationFrame(draw);
            }
        };

        const intersectionObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                isVisible = entry.isIntersecting;
                startLoop();
            });
        }, { threshold: 0.01 });
        intersectionObserver.observe(container);

        const resizeObserver = new ResizeObserver(() => {
            if (isVisible) startLoop();
        });
        resizeObserver.observe(container);

        return () => {
            isDrawing = false;
            intersectionObserver.disconnect();
            resizeObserver.disconnect();
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
        };
    } else {
        draw();

        const resizeObserver = new ResizeObserver(() => draw());
        resizeObserver.observe(container);

        return () => {
            resizeObserver.disconnect();
        };
    }
}

export function initMorphoLayouts() {
    const promises = [];
    document.querySelectorAll('.morpho-layout').forEach(container => {
        const src = container.getAttribute('data-src');
        if (!src) return;

        const animate = container.getAttribute('data-animate') !== 'false';
        const nodeSizeAttr = container.getAttribute('data-node-size');
        const nodeSize = nodeSizeAttr ? parseFloat(nodeSizeAttr) : 1.0;
        const colorByDepth = container.getAttribute('data-color-by-depth') === 'true';
        const masksAttr = container.getAttribute('data-masks');
        const maskUrls = masksAttr ? masksAttr.split(',') : [];
        const maskColorsAttr = container.getAttribute('data-mask-colors');
        const maskColors = maskColorsAttr ? maskColorsAttr.split(',') : [];
        const showResolvedBits = container.getAttribute('data-show-resolved-bits') === 'true';

        const fetchJson = u => fetch(u.trim()).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));
        const p = Promise.all([src, ...maskUrls].map(fetchJson))
            .then(([data, ...masks]) => {
                try {
                    renderLayout(container, data, { animate, nodeSize, colorByDepth, masks, maskColors, showResolvedBits });
                } catch (e) {
                    console.warn("WebGL layout initialization failed, preserving static fallback image:", e);
                }
            })
            .catch(err => {
                console.error("Failed to load layout/masks:", err);
                if (!container.querySelector('.layout-fallback')) {
                    Object.assign(container.style, { display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef4444', fontFamily: 'monospace' });
                    container.textContent = `[Error: ${err.message}]`;
                }
            });
        promises.push(p);
    });
    return Promise.all(promises);
}
