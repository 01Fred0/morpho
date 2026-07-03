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

import { SoA, mulberry32, clamp } from './utils.js';

let wasmInstance;
try {
    if (typeof window === 'undefined') {
        // Node.js environment
        const fs = await import('fs');
        const path = await import('path');
        const wasmPath = path.resolve(process.cwd(), 'graphs_engine/main.wasm');
        const buffer = fs.readFileSync(wasmPath);
        const wasmModule = await WebAssembly.instantiate(buffer);
        wasmInstance = wasmModule.instance;
    } else {
        // Browser environment
        const response = await fetch('graphs_engine/main.wasm?v=' + Date.now());
        const buffer = await response.arrayBuffer();
        const wasmModule = await WebAssembly.instantiate(buffer);
        wasmInstance = wasmModule.instance;
    }
} catch (e) {
    console.error("Failed to compile layout WASM: ", e);
}

// Initialize WASM state
if (wasmInstance) {
    const maxPoints = 65536;
    const maxNodes = 65536;
    const maxLinks = maxPoints * 4;
    wasmInstance.exports.init(maxPoints, maxNodes, maxLinks);
    wasmInstance.exports.setTheta(0.5);
}

function prepareWASM(instance) {
    const type2class = {
        uint8_t: Uint8Array,
        int: Int32Array,
        uint32_t: Uint32Array,
        uint64_t: BigUint64Array,
        float: Float32Array,
        simd_float_t: Float32Array
    };
    const prefix = '_len_';
    const exports = instance.exports;
    const main = {};
    const arrays = {};
    for (const key in exports) {
        if (!key.startsWith(prefix)) {
            if (!key.startsWith('_')) {
                main[key] = exports[key];
            }
            continue;
        }
        const [name, type] = key.slice(prefix.length).split('__');
        Object.defineProperty(main, name, {
            enumerable: true,
            get() {
                if (!(name in arrays) || arrays[name].buffer != exports.memory.buffer) { 
                    const ofs = exports['_get_'+name]();
                    const len = exports[key]();
                    if (!ofs) {
                        return null;
                    }
                    arrays[name] = new (type2class[type])(exports.memory.buffer, ofs, len);
                }
                return arrays[name];
            }
        });
    }
    return main;
}

const CELL_LAYOUT_SCHEMA = {
    x: [Float32Array, 0],
    y: [Float32Array, 0],
    r: [Float32Array, 1],
    fx: [Float32Array, 0],
    fy: [Float32Array, 0],
    vx: [Float32Array, 0],
    vy: [Float32Array, 0]
};

export class LayoutEngine {
    constructor(
        graph,
        seed = 1337,
        repulsionForce = 0.05,
        wireForce = 1.0,
        velocityDecay = 0.05,
        theta = 0.5,
        leafSize = 64,
        maxLevel = 10,
        linkDistance = 2.0,
        maxDist = 80.0,
        maxSpeed = 1.0,
        gravity = 0.1
    ) {
        this.node = new SoA(CELL_LAYOUT_SCHEMA, graph.cell.capacity);
        this.graph = graph;
        this.seed = seed;
        this.random = mulberry32(seed);
        this.repulsionForce = repulsionForce;
        this.wireForce = wireForce;
        this.velocityDecay = velocityDecay;
        this.theta = theta;
        this.leafSize = leafSize;
        this.maxLevel = maxLevel;
        this.linkDistance = linkDistance;
        this.maxDist = maxDist;
        this.maxSpeed = maxSpeed;
        this.gravity = gravity;

        this.wasm = prepareWASM(wasmInstance);
        this.pointN = 0;
        this.pos = this.wasm.points;
        this.vel = this.wasm.vel;

        this.particleToNode = null;
        this.nodeToParticle = null;
        this.activeCount = 0;

        this.wasm.setLinearCompensation(false);

        this._updateGraph();
    }

    _updateGraph() {
        const graph = this.graph;
        if (graph.cell.capacity > this.node.capacity) {
            this.node.grow(graph.cell.capacity);
        }

        if (graph.cell.count > this.node.count) {
            const start = this.node.count;
            const added = graph.cell.count - start;
            this.node.alloc(added);

            // Initialize position and size for new nodes
            for (let i = start; i < graph.cell.count; i++) {
                const parent = graph.cell.parent[i];
                if (parent == -1) {
                    this.node.x[i] = (this.random() - 0.5)*2.0;
                    this.node.y[i] = (this.random() - 0.5)*2.0;
                } else {
                    this.node.x[i] = this.node.x[parent] + (this.random() - 0.5)*2.0;
                    this.node.y[i] = this.node.y[parent] + (this.random() - 0.5)*2.0;
                }
                this.node.r[i] = 0.5;
            }
        }
    }

    _rebuildMappings() {
        const graph = this.graph;
        let activeCount = 0;
        for (let i = 0; i < graph.cell.count; i++) {
            if (graph.cell.active[i] === 1) {
                activeCount++;
            }
        }

        if (!this.particleToNode || this.particleToNode.length < activeCount) {
            this.particleToNode = new Int32Array(activeCount * 2);
        }
        if (!this.nodeToParticle || this.nodeToParticle.length < graph.cell.capacity) {
            this.nodeToParticle = new Int32Array(graph.cell.capacity).fill(-1);
        } else {
            this.nodeToParticle.fill(-1);
        }

        let pIdx = 0;
        for (let i = 0; i < graph.cell.count; i++) {
            if (graph.cell.active[i] === 1) {
                this.particleToNode[pIdx] = i;
                this.nodeToParticle[i] = pIdx;
                pIdx++;
            }
        }
        this.activeCount = activeCount;
    }

    relax(steps = 1) {
        const graph = this.graph;
        if (graph.cell.count > this.node.count) {
            this._updateGraph();
        }

        this._rebuildMappings();
        if (this.activeCount === 0) return;

        const active = graph.cell.active;

        // 1. Build flat links array from graph pins (deduplicated between cell pairs)
        const linksSet = new Set();
        for (let p = 0; p < graph.pin.count; p++) {
            const netIdx = graph.pin.net[p];
            if (netIdx === -1) continue;
            const src = graph.net.driverCell[netIdx];
            const dst = graph.pin.cell[p];
            if (src === -1 || dst === -1 || active[src] === 0 || active[dst] === 0) continue;

            const pSrc = this.nodeToParticle[src];
            const pDst = this.nodeToParticle[dst];
            if (pSrc === -1 || pDst === -1) continue;

            const linkKey = pSrc < pDst ? (pSrc | (pDst << 16)) : (pDst | (pSrc << 16));
            linksSet.add(linkKey);
        }

        const linksFlat = [];
        for (const key of linksSet) {
            const src = key & 0xFFFF;
            const dst = (key >> 16) & 0xFFFF;
            linksFlat.push(src, dst);
        }
        const links = new Int32Array(linksFlat);
        const linkN = links.length / 2;

        // Calculate node degrees
        const degrees = new Int32Array(this.activeCount);
        for (let i = 0; i < links.length; i += 2) {
            degrees[links[i]]++;
            degrees[links[i + 1]]++;
        }

        // 2. Set WASM data
        this.wasm.links.set(links);
        
        const weights = this.wasm.link_weights;
        for (let i = 0; i < linkN; i++) {
            const src = links[i * 2];
            const dst = links[i * 2 + 1];
            const sumDegrees = degrees[src] + degrees[dst];
            weights[i] = sumDegrees > 0 ? (1.0 / sumDegrees) : 1.0;
        }

        this.pointN = this.activeCount;

        // Sync JS positions & velocities to WASM points buffer
        const x = this.node.x;
        const y = this.node.y;
        const vx = this.node.vx;
        const vy = this.node.vy;
        for (let p = 0; p < this.activeCount; p++) {
            const i = this.particleToNode[p];
            this.pos[p * 3] = x[i];
            this.pos[p * 3 + 1] = y[i];
            this.pos[p * 3 + 2] = 0.0;
            this.vel[p * 3] = vx[i];
            this.vel[p * 3 + 1] = vy[i];
            this.vel[p * 3 + 2] = 0.0;
        }

        // 3. Set force parameters in WASM variables
        this.wasm.setTheta(this.theta);
        this.wasm.setMaxSpeed(this.maxSpeed);

        // Run simulation steps in WASM
        const f = 1.0 - this.velocityDecay;
        for (let step = 0; step < steps; step++) {
            this.wasm.linkForce(linkN, this.wireForce, this.linkDistance, this.pointN);

            const repulsionStrength = -this.repulsionForce;
            this.nodeCount = this.wasm.buildOctree(this.pointN, this.leafSize, this.maxLevel);
            this.wasm.calcMultibodyForce(this.pointN, this.nodeCount, this.maxDist);
            this.wasm.applyChargeForces(this.pointN, repulsionStrength);

            // Apply small centering gravity force
            const gravityStrength = this.gravity / Math.max(this.pointN, 16);
            for (let p = 0; p < this.pointN; p++) {
                const x = this.pos[p * 3];
                const y = this.pos[p * 3 + 1];
                this.vel[p * 3] -= x * gravityStrength;
                this.vel[p * 3 + 1] -= y * gravityStrength;
            }

            this.wasm.updateNodes(this.pointN, f);
        }

        // 4. Sync positions & velocities back to JS node arrays
        for (let p = 0; p < this.activeCount; p++) {
            const i = this.particleToNode[p];
            x[i] = this.pos[p * 3];
            y[i] = this.pos[p * 3 + 1];
            vx[i] = this.vel[p * 3];
            vy[i] = this.vel[p * 3 + 1];
        }
    }
}
