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

import { parse } from './parser.js';
import { compileModule, CELL_TYPES } from './compiler.js';
import { Grower } from './grower.js';
import { clamp } from './utils.js';
import {
    MAX_GL_NODES,
    MAX_GL_LINKS,
    LayoutRenderer,
    packNodes,
    packLinks,
    createLegendOverlay,
    TIMING_CONFIG
} from './layout_renderer.js';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 100.0;
const BASE_GRID_SCALE = 16.0;
const MAX_AUTOSCALE_ZOOM = 22.0;
const AUTOSCALE_PADDING = 1.125;

export class MorphoViewer {
    constructor(options = {}) {
        this.container = options.container || document.body;
        this.designName = options.design || 'ripple_adder';
        this.designInputs = options.inputs || [16, 16, 1];
        this.visibility = options.visibility || 'both';
        this.autoExpandSpeed = options.autoExpandSpeed !== undefined ? options.autoExpandSpeed : 40;
        this.interactive = options.interactive !== undefined ? options.interactive : true;
        this.hover = options.hover !== undefined ? options.hover : true;
        this.method = options.method || 'bfs';
        this.autoscale = options.autoscale !== undefined ? options.autoscale : false;
        this.colorEdgesByDepth = options.colorEdgesByDepth !== undefined ? options.colorEdgesByDepth : true;
        this.userInteracted = false;

        // Callbacks
        this.onGrowthComplete = options.onGrowthComplete || null;
        this.onCellAdded = options.onCellAdded || null;
        this.onActiveCellChanged = options.onActiveCellChanged || null;

        // Internal State
        this.graph = null;
        this.grower = null;
        this.code = "";
        
        this.isRunning = true;
        this.isAutoExpanding = options.autoExpand || false;
        this.lastFrameTime = 0;
        this.loopRunning = false;
        this.expansionsPending = 0;
        
        this.smoothedX = new Float32Array(0);
        this.smoothedY = new Float32Array(0);
        this.initializedCount = 0;

        this.activeCellId = null;
        this.activeDescendants = new Set();
        
        // Simulation / Signal Propagation State
        this.simActive = false;
        this.simTime = 0.0;
        this.tStep = options.tStep !== undefined ? options.tStep : TIMING_CONFIG.defaultTStep;
        this.maxDepth = 0.0;

        // Pan/Zoom State
        this.initPanX = options.panX || 0;
        this.initPanY = options.panY || 0;
        this.initZoom = options.zoom || 1.0;

        this.panX = this.initPanX;
        this.panY = this.initPanY;
        this.zoom = this.initZoom;

        this.nodesData = new Float32Array(MAX_GL_NODES * 12);
        this.linksData = new Float32Array(MAX_GL_LINKS * 8);
        this.glNodeCount = 0;
        this.glLinkCount = 0;
        this.needsTextureUpdate = true;
        this.needsTextureUpload = true;
        this.viewerId = Math.random().toString(36).substring(2, 9);

        // DOM elements
        this.canvas = null;
        this.tooltip = null;

        this._boundLoop = this.loop.bind(this);
        this._setupDOM();
    }

    _setupDOM() {
        if (window.getComputedStyle(this.container).position === 'static') {
            this.container.style.position = 'relative';
        }

        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        if (this.interactive) {
            this.canvas.style.cursor = 'grab';
            this.canvas.style.touchAction = 'none';
        }
        this.container.appendChild(this.canvas);

        this.tooltip = document.createElement('div');
        this.tooltip.id = 'node-tooltip'; // styled in style.css; shown via .visible
        this.container.appendChild(this.tooltip);

        this.renderer = new LayoutRenderer(this.canvas);

        if (this.interactive) {
            this._setupEvents();
        }
    }

    _zoomAt(mx, my, factor) {
        const cx = this.canvas.clientWidth / 2, cy = this.canvas.clientHeight / 2;
        const oldScale = BASE_GRID_SCALE * this.zoom;
        const wx = (mx - (cx + this.panX)) / oldScale;
        const wy = (my - (cy + this.panY)) / oldScale;

        this.zoom = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);

        const newScale = BASE_GRID_SCALE * this.zoom;
        this.panX = mx - cx - wx * newScale;
        this.panY = my - cy - wy * newScale;
    }

    _setupEvents() {
        const canvas = this.canvas;
        let dragMode = null; // 'pan' | 'zoom' | 'pinch'
        let lastX = 0, lastY = 0;
        let zoomAnchor = { x: 0, y: 0 };
        let startDist = 0, startZoom = 1;
        let pinchWorld = { x: 0, y: 0 };

        const pointers = new Map();

        this._pointerDown = (e) => {
            pointers.set(e.pointerId, e);
            canvas.setPointerCapture(e.pointerId);
            this.userInteracted = true;
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top;

            if (pointers.size === 1) {
                dragMode = (e.shiftKey || e.button === 1 || (e.buttons & 4) !== 0) ? 'zoom' : 'pan';
                canvas.style.cursor = dragMode === 'zoom' ? 'ns-resize' : 'grabbing';
                lastX = e.clientX;
                lastY = e.clientY;
                zoomAnchor = { x: mx, y: my };
            } else if (pointers.size === 2) {
                dragMode = 'pinch';
                const pts = Array.from(pointers.values());
                startDist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
                startZoom = this.zoom;
                const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
                const pmx = (pts[0].clientX + pts[1].clientX) / 2 - rect.left;
                const pmy = (pts[0].clientY + pts[1].clientY) / 2 - rect.top;
                pinchWorld = { x: (pmx - (cx + this.panX)) / (BASE_GRID_SCALE * this.zoom), y: (pmy - (cy + this.panY)) / (BASE_GRID_SCALE * this.zoom) };
            }
        };

        this._pointerMove = (e) => {
            if (!pointers.has(e.pointerId)) {
                if (pointers.size === 0) this._handleHover(e);
                return;
            }
            pointers.set(e.pointerId, e);

            if (dragMode === 'pan' && pointers.size === 1) {
                this.panX += e.clientX - lastX;
                this.panY += e.clientY - lastY;
                lastX = e.clientX;
                lastY = e.clientY;
                this.tooltip.classList.remove('visible');
            } else if (dragMode === 'zoom' && pointers.size === 1) {
                const dy = e.clientY - lastY;
                lastY = e.clientY;
                if (dy !== 0) this._zoomAt(zoomAnchor.x, zoomAnchor.y, Math.exp(-dy * 0.008));
                this.tooltip.classList.remove('visible');
            } else if (dragMode === 'pinch' && pointers.size === 2) {
                const pts = Array.from(pointers.values());
                const dist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
                this.zoom = clamp(startZoom * (dist / startDist), MIN_ZOOM, MAX_ZOOM);
                const rect = canvas.getBoundingClientRect();
                const pmx = (pts[0].clientX + pts[1].clientX) / 2 - rect.left;
                const pmy = (pts[0].clientY + pts[1].clientY) / 2 - rect.top;
                const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
                const scale = BASE_GRID_SCALE * this.zoom;
                this.panX = pmx - cx - pinchWorld.x * scale;
                this.panY = pmy - cy - pinchWorld.y * scale;
            }
        };

        this._pointerUp = (e) => {
            pointers.delete(e.pointerId);
            if (pointers.size === 0) {
                dragMode = null;
                canvas.style.cursor = 'grab';
            } else if (pointers.size === 1) {
                const rem = Array.from(pointers.values())[0];
                dragMode = (rem.shiftKey || (rem.buttons & 4) !== 0) ? 'zoom' : 'pan';
                canvas.style.cursor = dragMode === 'zoom' ? 'ns-resize' : 'grabbing';
                lastX = rem.clientX;
                lastY = rem.clientY;
                const rect = canvas.getBoundingClientRect();
                zoomAnchor = { x: rem.clientX - rect.left, y: rem.clientY - rect.top };
            }
        };

        this._wheel = (e) => {
            e.preventDefault();
            this.userInteracted = true;
            const rect = canvas.getBoundingClientRect();
            this._zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.05 : 0.95);
        };

        this._preventMiddleClick = (e) => { if (e.button === 1) e.preventDefault(); };

        canvas.addEventListener('pointerdown', this._pointerDown);
        window.addEventListener('pointermove', this._pointerMove);
        window.addEventListener('pointerup', this._pointerUp);
        window.addEventListener('pointercancel', this._pointerUp);
        canvas.addEventListener('wheel', this._wheel, { passive: false });
        canvas.addEventListener('mousedown', this._preventMiddleClick);
        canvas.addEventListener('auxclick', this._preventMiddleClick);
    }

    _handleHover(e) {
        if (!this.hover || !this.graph) return;

        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (mx < 0 || mx > rect.width || my < 0 || my > rect.height) {
            this.tooltip.classList.remove('visible');
            return;
        }

        const cx = this.canvas.clientWidth / 2;
        const cy = this.canvas.clientHeight / 2;
        const scale = BASE_GRID_SCALE * this.zoom;
        const wx = (mx - (cx + this.panX)) / scale;
        const wy = (my - (cy + this.panY)) / scale;

        let hoveredIdx = -1;
        let minDistance = Infinity;

        for (let i = 0; i < this.graph.cell.count; i++) {
            if (this.graph.cell.active[i] !== 1) continue;
            const dx = wx - this.smoothedX[i];
            const dy = wy - this.smoothedY[i];
            const dist = Math.sqrt(dx * dx + dy * dy);
            let r = this.grower.layout.node.r[i] || 0.5;
            if (this.graph.cell.name[i] === 'BUF') {
                r *= 0.5;
            }
            if (dist <= r && dist < minDistance) {
                minDistance = dist;
                hoveredIdx = i;
            }
        }

        if (hoveredIdx !== -1) {
            const name = this.graph.cell.name[hoveredIdx];
            const typeCode = this.graph.cell.type[hoveredIdx];
            const typeName = typeCode === CELL_TYPES.INPUT ? 'INPUT' :
                             typeCode === CELL_TYPES.OUTPUT ? 'OUTPUT' :
                             typeCode === CELL_TYPES.LUT ? 'LUT' : 'MORPHO';
            const parentIdx = this.graph.cell.parent[hoveredIdx];

            const inputCount = this.graph.cell.inputCount[hoveredIdx];
            const outputCount = this.graph.cell.outputCount[hoveredIdx];

            const inputNets = [];
            const pinStart = this.graph.cell.pinStart[hoveredIdx];
            for (let j = 0; j < inputCount; j++) {
                inputNets.push(this.graph.pin.net[pinStart + j]);
            }

            const outputNets = [];
            const netStart = this.graph.cell.netStart[hoveredIdx];
            if (netStart !== -1) {
                for (let j = 0; j < outputCount; j++) {
                    outputNets.push(netStart + j);
                }
            }

            let html = `
                <div class="tooltip-title">
                    <span>${name || 'Unnamed Cell'}</span>
                    <span class="tooltip-type">${typeName}</span>
                </div>
                <div class="tooltip-row">
                    <span class="tooltip-label">Cell Index</span>
                    <span>#${hoveredIdx}</span>
                </div>
            `;

            if (parentIdx !== -1) {
                const chain = [];
                let curr = parentIdx;
                while (curr !== -1) {
                    chain.push(curr);
                    curr = this.graph.cell.parent[curr];
                }
                const collapsedNames = [];
                for (const pIdx of chain) {
                    const pName = this.graph.cell.name[pIdx] || 'Unnamed';
                    if (collapsedNames.length === 0 || collapsedNames[collapsedNames.length - 1] !== pName) {
                        collapsedNames.push(pName);
                    }
                }
                collapsedNames.reverse();
                
                const chainHTML = collapsedNames.map((pName, i) => {
                    const suffix = (i === collapsedNames.length - 1) ? ` (#${parentIdx})` : '';
                    const color = i === collapsedNames.length - 1 ? '#e2e8f0' : '#8492a6';
                    const bullet = i === 0 ? '' : '↳ ';
                    return `<div class="tooltip-parent-item" style="padding-left: ${i * 10}px; color: ${color};">${bullet}${pName}${suffix}</div>`;
                }).join('');
                
                html += `
                    <div class="tooltip-parent-section">
                        <div class="tooltip-parent-label">Parent Chain</div>
                        <div class="tooltip-parent-list">${chainHTML}</div>
                    </div>
                `;
            }

            html += `<div class="tooltip-divider"></div>`;

            html += `
                <div class="tooltip-row">
                    <span class="tooltip-label">Inputs (${inputCount})</span>
                    <span>[${inputNets.join(', ')}]</span>
                </div>
                <div class="tooltip-row">
                    <span class="tooltip-label">Outputs (${outputCount})</span>
                    <span>[${outputNets.join(', ')}]</span>
                </div>
            `;

            if (typeCode === CELL_TYPES.LUT) {
                const lutValue = this.graph.cell.lutValue[hoveredIdx];
                html += `
                    <div class="tooltip-row">
                        <span class="tooltip-label">LUT Value</span>
                        <span>0x${lutValue.toString(16).toUpperCase()}</span>
                    </div>
                `;
            }

            this.tooltip.innerHTML = html;
            this.tooltip.classList.add('visible');

            const tooltipWidth = this.tooltip.offsetWidth || 220;
            const tooltipHeight = this.tooltip.offsetHeight || 150;
            
            let left = mx + 15;
            let top = my + 15;
            
            if (left + tooltipWidth > rect.width) {
                left = mx - tooltipWidth - 15;
            }
            if (top + tooltipHeight > rect.height) {
                top = my - tooltipHeight - 15;
            }
            
            this.tooltip.style.left = `${left}px`;
            this.tooltip.style.top = `${top}px`;
        } else {
            this.tooltip.classList.remove('visible');
        }
    }

    init(code) {
        this.code = code;
        const ast = parse(code);
        const { createRoot } = compileModule(ast, this.designName, this.designInputs, true, 4);

        this.graph = createRoot();
        this.grower = new Grower(this.graph, true);

        this.smoothedX = new Float32Array(this.graph.cell.capacity);
        this.smoothedY = new Float32Array(this.graph.cell.capacity);
        this.initializedCount = 0;
        this._legendKey = null;

        this.activeCellId = null;
        this.activeDescendants.clear();

        if (this.onCellAdded) {
            for (let i = 0; i < this.graph.cell.count; i++) {
                this.onCellAdded(i, this.graph.cell.name[i], this.graph.cell.parent[i]);
            }
        }

        this.startLoop();
    }

    startLoop() {
        if (!this.loopRunning && this.graph) {
            this.loopRunning = true;
            this.lastFrameTime = performance.now();
            requestAnimationFrame(this._boundLoop);
        }
    }

    stopLoop() {
        this.loopRunning = false;
    }

    setDesign(designName, designInputs, method) {
        this.designName = designName;
        this.designInputs = designInputs;
        if (method) this.method = method;
        
        this.stopAutoExpand();
        this.stopSimulation();
        
        this.panX = this.initPanX;
        this.panY = this.initPanY;
        this.zoom = this.initZoom;
        this.userInteracted = false;
        
        if (this.code) this.init(this.code);
    }

    reset() {
        this.simActive = false;
        this.simTime = 0.0;
        if (this.code) this.init(this.code);
    }

    isFullyExpanded() {
        return this.grower ? this.grower.isFullyExpanded() : true;
    }

    stepExpand() {
        const firstIdx = this.graph.cell.count;
        const expanded = this.grower.expand(this.method);
        if (expanded) {
            this.needsTextureUpdate = true;
            this._notifyNewCells(firstIdx);
        }
        return expanded;
    }

    _notifyNewCells(startIdx) {
        if (!this.onCellAdded) return;
        const count = this.graph.cell.count;
        for (let i = startIdx; i < count; i++) {
            this.onCellAdded(i, this.graph.cell.name[i], this.graph.cell.parent[i]);
        }
    }

    startAutoExpand(speed) {
        if (speed !== undefined) this.autoExpandSpeed = speed;
        this.isAutoExpanding = true;
    }

    stopAutoExpand() {
        this.isAutoExpanding = false;
        this.expansionsPending = 0;
    }

    // Recompute signal arrival times and the max logic depth of the graph
    _refreshDepth() {
        this.graph.updateTimes();
        let maxT = 0;
        for (let i = 0; i < this.graph.cell.count; i++) {
            if (this.graph.cell.active[i] === 1 && this.graph.cell.lastTime[i] > maxT) {
                maxT = this.graph.cell.lastTime[i];
            }
        }
        this.maxDepth = maxT;
        this.needsTextureUpdate = true;
    }

    startSimulation() {
        this._refreshDepth();
        this.simTime = -TIMING_CONFIG.pauseDuration - TIMING_CONFIG.fadeDuration;
        this.simActive = true;
    }

    stopSimulation() {
        this.simActive = false;
        this.simTime = 0.0;
    }

    setActiveCell(cellId) {
        this.activeCellId = cellId;
        this.activeDescendants.clear();
        if (cellId !== null) {
            this.activeDescendants.add(cellId);
            for (let i = cellId + 1; i < this.graph.cell.count; i++) {
                if (this.activeDescendants.has(this.graph.cell.parent[i])) {
                    this.activeDescendants.add(i);
                }
            }
        }
        this.needsTextureUpdate = true;
        if (this.onActiveCellChanged) {
            this.onActiveCellChanged(cellId);
        }
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.floor(this.canvas.clientWidth * dpr);
        const h = Math.floor(this.canvas.clientHeight * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
    }

    loop(timestamp) {
        if (!this.loopRunning) return;
        if (!this.graph) {
            this.loopRunning = false;
            return;
        }
        this.resize();

        const dt = Math.min((timestamp - this.lastFrameTime) / 1000, 0.1);
        this.lastFrameTime = timestamp;

        if (this.isAutoExpanding && this.isRunning) {
            this.expansionsPending += this.autoExpandSpeed * dt * this.graph.cell.count / 100.0;
            while (this.expansionsPending >= 1) {
                this.expansionsPending -= 1;
                if (!this.stepExpand()) {
                    this.isAutoExpanding = false;
                    this.expansionsPending = 0;
                    if (this.onGrowthComplete) this.onGrowthComplete();
                    break;
                }
            }
        }

        if (this.isRunning) {
            this.grower.relaxLayout(2);
            this.needsTextureUpdate = true;
        }

        if (this.graph.cell.capacity > this.smoothedX.length) {
            const newX = new Float32Array(this.graph.cell.capacity);
            const newY = new Float32Array(this.graph.cell.capacity);
            newX.set(this.smoothedX);
            newY.set(this.smoothedY);
            this.smoothedX = newX;
            this.smoothedY = newY;
        }

        if (this.initializedCount < this.graph.cell.count) {
            this._refreshDepth();
        }
        for (let i = this.initializedCount; i < this.graph.cell.count; i++) {
            const parent = this.graph.cell.parent[i];
            if (parent !== -1 && parent < this.initializedCount) {
                this.smoothedX[i] = this.smoothedX[parent];
                this.smoothedY[i] = this.smoothedY[parent];
            } else {
                this.smoothedX[i] = this.grower.layout.node.x[i];
                this.smoothedY[i] = this.grower.layout.node.y[i];
            }
        }
        this.initializedCount = this.graph.cell.count;

        const easing = 0.1;
        let anyNodeMoved = false;
        let xMin = Infinity, xMax = -Infinity;
        let yMin = Infinity, yMax = -Infinity;
        let activeCount = 0;

        for (let i = 0; i < this.graph.cell.count; i++) {
            if (this.graph.cell.active[i] === 0) continue;
            const tx = this.grower.layout.node.x[i];
            const ty = this.grower.layout.node.y[i];
            const dx = tx - this.smoothedX[i];
            const dy = ty - this.smoothedY[i];
            if (Math.abs(dx) > 0.005 || Math.abs(dy) > 0.005) {
                anyNodeMoved = true;
            }
            this.smoothedX[i] += dx * easing;
            this.smoothedY[i] += dy * easing;

            const px = this.smoothedX[i];
            const py = this.smoothedY[i];
            xMin = Math.min(xMin, px);
            xMax = Math.max(xMax, px);
            yMin = Math.min(yMin, py);
            yMax = Math.max(yMax, py);
            activeCount++;
        }

        if (this.autoscale && !this.userInteracted && activeCount > 0) {
            const graphW = xMax - xMin;
            const graphH = yMax - yMin;
            const fitW = this.canvas.clientWidth - 80;
            const fitY = this.initPanY < 0 ? 145 : 80;
            const fitH = this.canvas.clientHeight - fitY;

            if (graphW > 0 && graphH > 0 && fitW > 0 && fitH > 0) {
                const targetZoom = clamp(Math.min(fitW / graphW, fitH / graphH) / (BASE_GRID_SCALE * AUTOSCALE_PADDING), MIN_ZOOM, MAX_AUTOSCALE_ZOOM);
                this.zoom += (targetZoom - this.zoom) * 0.1;
            }
        }

        if (this.simActive && this.isRunning) {
            this.simTime += dt;
            if (this.simTime > this.maxDepth * this.tStep) {
                this.simTime = -TIMING_CONFIG.pauseDuration - TIMING_CONFIG.fadeDuration;
            }
        }

        if (this.needsTextureUpdate || anyNodeMoved) {
            this._updateWebGLBuffers();
            this.needsTextureUpdate = false;
        }

        this._renderWebGL();
        requestAnimationFrame(this._boundLoop);
    }

    _updateWebGLBuffers() {
        this.glNodeCount = packNodes(
            this.graph,
            this.grower.layout.node.r,
            this.smoothedX,
            this.smoothedY,
            this.activeCellId,
            this.activeDescendants,
            this.nodesData
        );
        this.glLinkCount = packLinks(
            this.graph,
            this.smoothedX,
            this.smoothedY,
            this.activeCellId,
            this.activeDescendants,
            this.linksData
        );
        // Legend contents only change when the graph grows or visibility flips —
        // skip the HTML rebuild on pure layout/simulation frames.
        const legendKey = `${this.graph.cell.count}|${this.visibility}`;
        if (legendKey !== this._legendKey) {
            this._legendKey = legendKey;
            createLegendOverlay(this.container, this.graph, false, this.visibility === 'wires');
        }
        this.needsTextureUpload = true;
    }

    _renderWebGL() {
        const cx = this.canvas.clientWidth / 2;
        const cy = this.canvas.clientHeight / 2;
        const scale = BASE_GRID_SCALE * this.zoom;

        const logDist = Math.log(80 / scale) / Math.log(10);
        const k = Math.floor(logDist);
        const fWeight = logDist - k;
        const step0 = Math.pow(10, k);

        const xMin = (0 - (cx + this.panX)) / scale;
        const xMax = (this.canvas.clientWidth - (cx + this.panX)) / scale;
        const yMin = (0 - (cy + this.panY)) / scale;
        const yMax = (this.canvas.clientHeight - (cy + this.panY)) / scale;

        const numVertLines = Math.floor((xMax - xMin) / step0) + 2;
        const numHorizLines = Math.floor((yMax - yMin) / step0) + 2;

        const showNodes = this.visibility === 'both' || this.visibility === 'nodes';
        const showWires = this.visibility === 'both' || this.visibility === 'wires';

        this.renderer.render({
            width: this.canvas.clientWidth,
            height: this.canvas.clientHeight,
            panX: this.panX,
            panY: this.panY,
            zoom: this.zoom,
            simTime: this.simTime,
            simActive: this.simActive,
            maxDepth: this.maxDepth,
            tStep: this.tStep,
            colorEdgesByDepth: this.colorEdgesByDepth,
            isDynamic: true,
            grid: { numVertLines, numHorizLines, fWeight },
            id: this.viewerId,
            nodesData: this.needsTextureUpload ? this.nodesData : undefined,
            nodeCount: showNodes ? this.glNodeCount : 0,
            linksData: this.needsTextureUpload ? this.linksData : undefined,
            linkCount: showWires ? this.glLinkCount : 0
        });
        
        this.needsTextureUpload = false;
    }

    exportJSON() {
        if (!this.graph) return null;

        const active = this.graph.cell.active;
        const count = this.graph.cell.count;
        const fmt = (num) => parseFloat(num.toPrecision(5));

        const activeIndices = [];
        const indexMap = new Map();
        for (let i = 0; i < count; i++) {
            if (active[i] !== 0) {
                indexMap.set(i, activeIndices.length);
                activeIndices.push(i);
            }
        }

        if (activeIndices.length === 0) return null;

        const x = [];
        const y = [];
        const labels = [];
        const unique_labels = [];
        const labelToIdx = new Map();

        for (const i of activeIndices) {
            x.push(fmt(this.smoothedX[i]));
            y.push(fmt(this.smoothedY[i]));

            const name = this.graph.cell.name[i];
            const type = this.graph.cell.type[i];
            let nodeLabel = name;

            if (type === CELL_TYPES.INPUT || type === CELL_TYPES.OUTPUT) {
                let rootCellIdx = i;
                while (this.graph.cell.parent[rootCellIdx] !== -1 && 
                       this.graph.cell.parent[rootCellIdx] !== rootCellIdx) {
                    rootCellIdx = this.graph.cell.parent[rootCellIdx];
                }
                const rootName = this.graph.cell.name[rootCellIdx];

                let bitIdx = 0;
                if (type === CELL_TYPES.INPUT) {
                    const rootNStart = this.graph.cell.netStart[rootCellIdx];
                    const netStart = this.graph.cell.netStart[i];
                    bitIdx = netStart - rootNStart;
                } else {
                    const rootPStart = this.graph.cell.pinStart[rootCellIdx];
                    const pinStart = this.graph.cell.pinStart[i];
                    bitIdx = pinStart - rootPStart;
                }
                const prefix = type === CELL_TYPES.INPUT ? "in:" : "out:";
                nodeLabel = `${prefix}${rootName}[${bitIdx}]`;
            }

            let labelIdx = labelToIdx.get(nodeLabel);
            if (labelIdx === undefined) {
                labelIdx = unique_labels.length;
                unique_labels.push(nodeLabel);
                labelToIdx.set(nodeLabel, labelIdx);
            }
            labels.push(labelIdx);
        }

        const edges = [];
        for (let netIdx = 0; netIdx < this.graph.net.count; netIdx++) {
            const driver = this.graph.net.driverCell[netIdx];
            if (driver === -1 || active[driver] === 0) continue;

            const driverMapped = indexMap.get(driver);
            if (driverMapped === undefined) continue;

            for (const pinIdx of this.graph.getNetPins(netIdx)) {
                const terminal = this.graph.pin.cell[pinIdx];
                if (terminal === -1 || active[terminal] === 0 || terminal === driver) continue;

                const terminalMapped = indexMap.get(terminal);
                if (terminalMapped === undefined) continue;

                edges.push(driverMapped, terminalMapped);
            }
        }

        return JSON.stringify({ x, y, labels, unique_labels, edges });
    }

    exportMask() {
        if (!this.graph) return null;

        const active = this.graph.cell.active;
        const count = this.graph.cell.count;
        
        const activeIndices = [];
        const indexMap = new Map();
        for (let i = 0; i < count; i++) {
            if (active[i] !== 0) {
                indexMap.set(i, activeIndices.length);
                activeIndices.push(i);
            }
        }
        
        const mask = [];
        if (this.activeCellId !== null) {
            for (const i of this.activeDescendants) {
                if (indexMap.has(i)) {
                    mask.push(indexMap.get(i));
                }
            }
        }
        
        mask.sort((a, b) => a - b);
        return JSON.stringify(mask);
    }

    destroy() {
        this.stopAutoExpand();
        this.stopSimulation();
        this.graph = null;
        
        if (this.interactive) {
            this.canvas.removeEventListener('pointerdown', this._pointerDown);
            window.removeEventListener('pointermove', this._pointerMove);
            window.removeEventListener('pointerup', this._pointerUp);
            window.removeEventListener('pointercancel', this._pointerUp);
            this.canvas.removeEventListener('wheel', this._wheel);
            if (this._preventMiddleClick) {
                this.canvas.removeEventListener('mousedown', this._preventMiddleClick);
                this.canvas.removeEventListener('auxclick', this._preventMiddleClick);
            }
        }

        this.canvas.remove();
        this.tooltip.remove();
    }
}
