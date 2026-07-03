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

import { SoA, shuffle, mulberry32 } from './utils.js';

const CELL_LAYOUT_SCHEMA = {
    x: [Float32Array, 0],   // Physical X
    y: [Float32Array, 0],   // Physical Y
    r: [Float32Array, 1],   // Radius (rendering)
    gq: [Int32Array, 0],    // Grid Q (axial)
    gr: [Int32Array, 0],    // Grid R (axial)
    moveCosts: [Float32Array, 0, 6]
};

// Static neighbor offsets for pointy-topped hexagons
const HEX_NEIGHBORS = [
    [1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]
];

// Helper to pack axial coordinates (q, r) into a single 32-bit integer
const packKey = (q, r) => (q & 0xFFFF) | ((r & 0xFFFF) << 16);

export class HexLayoutEngine {
    constructor(graph, seed = 1337) {
        this.node = new SoA(CELL_LAYOUT_SCHEMA, graph.cell.capacity);
        this.graph = graph;
        this.occupied = new Map(); // key (int32) -> cellIdx
        this.T0 = 0.5;
        this.temperature = this.T0;
        this.decay = 0.98;
        this.random = mulberry32(seed);
        this._updateGraph();
    }

    _setNodeGridPos(i, q, r) {
        this.node.gq[i] = q;
        this.node.gr[i] = r;
    }

    _findNearestVacantPath(startQ, startR) {
        const startKey = packKey(startQ, startR);
        if (!this.occupied.has(startKey)) {
            return [{ q: startQ, r: startR }];
        }

        const queue = [{ q: startQ, r: startR, parent: -1 }];
        const visited = new Set([startKey]);

        let head = 0;
        while (head < queue.length) {
            const { q, r } = queue[head];
            const parentIdx = head++;

            for (let i = 0; i < 6; i++) {
                const nq = q + HEX_NEIGHBORS[i][0];
                const nr = r + HEX_NEIGHBORS[i][1];
                const key = packKey(nq, nr);
                
                if (visited.has(key)) continue;
                visited.add(key);

                queue.push({ q: nq, r: nr, parent: parentIdx });
                if (!this.occupied.has(key)) {
                    // Reconstruct path
                    const path = [];
                    let currIdx = queue.length - 1;
                    while (currIdx !== -1) {
                        const node = queue[currIdx];
                        path.push({ q: node.q, r: node.r });
                        currIdx = node.parent;
                    }
                    path.reverse();
                    return path;
                }
            }
        }
        return null;
    }

    _updateGraph() {
        const graph = this.graph;
        if (graph.cell.capacity > this.node.capacity) {
            this.node.grow(graph.cell.capacity);
        }

        // Clean up deactivated cells from occupancy map
        for (let i = 0; i < this.node.count; i++) {
            if (graph.cell.active[i] === 0) {
                const key = packKey(this.node.gq[i], this.node.gr[i]);
                if (this.occupied.get(key) === i) {
                    this.occupied.delete(key);
                }
            }
        }

        if (graph.cell.count > this.node.count) {
            const start = this.node.count;
            const added = graph.cell.count - start;
            this.node.alloc(added);
            this.temperature = this.T0;

            for (let i = start; i < graph.cell.count; i++) {
                const parent = graph.cell.parent[i];
                this.node.r[i] = 0.45; // Default normalized hex node radius

                const startQ = parent === -1 ? 0 : this.node.gq[parent];
                const startR = parent === -1 ? 0 : this.node.gr[parent];
                const path = this._findNearestVacantPath(startQ, startR);

                if (parent === -1) {
                    const vacant = path[path.length - 1];
                    this._setNodeGridPos(i, vacant.q, vacant.r);
                    this.occupied.set(packKey(vacant.q, vacant.r), i);
                } else {
                    for (let k = path.length - 2; k >= 0; k--) {
                        const curr = path[k];
                        const next = path[k + 1];
                        const currKey = packKey(curr.q, curr.r);
                        const nextKey = packKey(next.q, next.r);

                        const cellIdx = this.occupied.get(currKey);
                        this._setNodeGridPos(cellIdx, next.q, next.r);

                        this.occupied.delete(currKey);
                        this.occupied.set(nextKey, cellIdx);
                    }

                    const first = path[0];
                    this._setNodeGridPos(i, first.q, first.r);
                    this.occupied.set(packKey(first.q, first.r), i);
                }
            }
        }
    }

    _getPhysicalDist(i, j) {
        const dq = this.node.gq[j] - this.node.gq[i];
        const dr = this.node.gr[j] - this.node.gr[i];
        return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr));
    }

    _getConnectedWiresLength(i) {
        let len = 0;
        const graph = this.graph;
        const active = graph.cell.active;

        // 1. Sum distances for input pins
        const pinStart = graph.cell.pinStart[i];
        const inputCount = graph.cell.inputCount[i];
        for (let p = 0; p < inputCount; p++) {
            const pinIdx = pinStart + p;
            const netIdx = graph.pin.net[pinIdx];
            if (netIdx === -1) continue;
            const src = graph.net.driverCell[netIdx];
            if (src !== -1 && src !== i && active[src] === 1) {
                len += this._getPhysicalDist(i, src);
            }
        }

        // 2. Sum distances for output nets
        const netStart = graph.cell.netStart[i];
        const outputCount = graph.cell.outputCount[i];
        if (netStart !== -1) {
            for (let n = 0; n < outputCount; n++) {
                const netIdx = netStart + n;
                const pins = graph.getNetPins(netIdx);
                for (const curr of pins) {
                    const dst = graph.pin.cell[curr];
                    if (dst !== -1 && dst !== i && active[dst] === 1) {
                        len += this._getPhysicalDist(i, dst);
                    }
                }
            }
        }
        return len;
    }

    _accumulateMoveCosts() {
        const graph = this.graph;
        const active = graph.cell.active;
        const count = graph.cell.count;
        const gq = this.node.gq;
        const gr = this.node.gr;
        const moveCosts = this.node.moveCosts;

        moveCosts.fill(0.0, 0, count * 6);

        const pinCount = graph.pin.count;
        for (let pinIdx = 0; pinIdx < pinCount; pinIdx++) {
            const v = graph.pin.cell[pinIdx];
            if (v === -1 || active[v] === 0) continue;

            const netIdx = graph.pin.net[pinIdx];
            if (netIdx === -1) continue;

            const u = graph.net.driverCell[netIdx];
            if (u === -1 || u === v || active[u] === 0) continue;

            const uq = gq[u];
            const ur = gr[u];
            const vq = gq[v];
            const vr = gr[v];

            const dq = vq - uq;
            const dr = vr - ur;
            const dy = -dq - dr;

            const qp = dq >= 0 ? 1 : -1, qm = dq <= 0 ? 1 : -1;
            const rp = dr >= 0 ? 1 : -1, rm = dr <= 0 ? 1 : -1;
            const sp = dy >= 0 ? 1 : -1, sm = dy <= 0 ? 1 : -1;

            const c0 = (qp + sm) >> 1;
            const c1 = (qm + sp) >> 1;
            const c2 = (rp + sm) >> 1;
            const c3 = (rm + sp) >> 1;
            const c4 = (qp + rm) >> 1;
            const c5 = (qm + rp) >> 1;

            const dist = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dy));

            if (!(dist === 1 && c0 === -1)) { moveCosts[v * 6 + 0] += c0; moveCosts[u * 6 + 1] += c0; }
            if (!(dist === 1 && c1 === -1)) { moveCosts[v * 6 + 1] += c1; moveCosts[u * 6 + 0] += c1; }
            if (!(dist === 1 && c2 === -1)) { moveCosts[v * 6 + 2] += c2; moveCosts[u * 6 + 3] += c2; }
            if (!(dist === 1 && c3 === -1)) { moveCosts[v * 6 + 3] += c3; moveCosts[u * 6 + 2] += c3; }
            if (!(dist === 1 && c4 === -1)) { moveCosts[v * 6 + 4] += c4; moveCosts[u * 6 + 5] += c4; }
            if (!(dist === 1 && c5 === -1)) { moveCosts[v * 6 + 5] += c5; moveCosts[u * 6 + 4] += c5; }
        }
    }

    _updatePhysicalCoordinates() {
        const graph = this.graph;
        const count = graph.cell.count;
        const active = graph.cell.active;
        const gq = this.node.gq;
        const gr = this.node.gr;
        const x = this.node.x;
        const y = this.node.y;

        let sumX = 0;
        let sumY = 0;
        let activeCount = 0;

        const sqrt3_2 = Math.sqrt(3) / 2;

        for (let i = 0; i < count; i++) {
            if (active[i] === 0) continue;
            const q = gq[i];
            const r = gr[i];
            
            const px = q + r * 0.5;
            const py = sqrt3_2 * r;
            
            x[i] = px;
            y[i] = py;
            
            sumX += px;
            sumY += py;
            activeCount++;
        }

        if (activeCount === 0) return;

        const cx = sumX / activeCount;
        const cy = sumY / activeCount;

        const r_cm = Math.round(cy / sqrt3_2);
        const q_cm = Math.round(cx - r_cm * 0.5);

        const snapCx = q_cm + r_cm * 0.5;
        const snapCy = r_cm * sqrt3_2;

        for (let i = 0; i < count; i++) {
            if (active[i] === 0) continue;
            x[i] -= snapCx;
            y[i] -= snapCy;
        }
    }

    relax(steps = 1) {
        const graph = this.graph;
        if (graph.cell.count > this.node.count) {
            this._updateGraph();
        }

        const count = graph.cell.count;
        const active = graph.cell.active;
        const gq = this.node.gq;
        const gr = this.node.gr;

        const neighborIndices = [0, 1, 2, 3, 4, 5];

        for (let s = 0; s < steps; s++) {
            this._accumulateMoveCosts();

            for (let i = 0; i < count; i++) {
                if (active[i] === 0) continue;

                const q = gq[i];
                const r = gr[i];

                shuffle(neighborIndices, this.random);

                for (let k = 0; k < 6; k++) {
                    const idx = neighborIndices[k];
                    const offset = HEX_NEIGHBORS[idx];
                    const nq = q + offset[0];
                    const nr = r + offset[1];

                    const key = packKey(nq, nr);
                    const j = this.occupied.get(key) ?? -1;
                    if (j === -1 || (j > i && active[j] === 1)) {
                        const deltaE = (j === -1) 
                            ? this.node.moveCosts[i * 6 + idx] * 2 
                            : (this.node.moveCosts[i * 6 + idx] + this.node.moveCosts[j * 6 + (idx ^ 1)]);

                        if (deltaE < 0 || (this.temperature > 0.0005 && this.random() < Math.exp(-deltaE / this.temperature))) {
                            const oldKey = packKey(q, r);
                            if (j === -1) {
                                this.occupied.delete(oldKey);
                            } else {
                                this.occupied.set(oldKey, j);
                                this._setNodeGridPos(j, q, r);
                            }
                            this.occupied.set(key, i);
                            this._setNodeGridPos(i, nq, nr);
                            break;
                        }
                    }
                }
            }
            this.temperature *= this.decay;
        }
        this._updatePhysicalCoordinates();
    }
}

export function solveShortestPathTree(points, driverIndex = 0, alpha = 0.3) {
    const len = points.length;
    if (len <= 1) {
        return { length: 0, segments: [] };
    }

    const inTree = new Uint8Array(len);
    const parent = new Int32Array(len);
    const pathDist = new Float64Array(len);

    inTree[driverIndex] = 1;
    parent[driverIndex] = -1;
    pathDist[driverIndex] = 0.0;

    for (let step = 1; step < len; step++) {
        let minCost = Infinity;
        let bestU = -1;
        let bestV = -1;

        for (let u = 0; u < len; u++) {
            if (inTree[u] !== 0) continue;

            const pu = points[u];
            for (let v = 0; v < len; v++) {
                if (inTree[v] === 0) continue;

                const pv = points[v];
                const dx = pu.x - pv.x;
                const dy = pu.y - pv.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                const cost = alpha * pathDist[v] + dist;
                if (cost < minCost) {
                    minCost = cost;
                    bestU = u;
                    bestV = v;
                }
            }
        }

        if (bestU === -1) break;

        inTree[bestU] = 1;
        parent[bestU] = bestV;
        
        const pu = points[bestU];
        const pv = points[bestV];
        const dx = pu.x - pv.x;
        const dy = pu.y - pv.y;
        pathDist[bestU] = pathDist[bestV] + Math.sqrt(dx * dx + dy * dy);
    }

    const segments = [];
    let totalLength = 0;
    for (let u = 0; u < len; u++) {
        if (u === driverIndex) continue;
        const v = parent[u];
        if (v === -1) continue;

        const pu = points[u];
        const pv = points[v];
        const dx = pu.x - pv.x;
        const dy = pu.y - pv.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        totalLength += dist;
        const seg = [pv, pu];
        seg.d1 = pathDist[v];
        seg.d2 = pathDist[u];
        segments.push(seg);
    }

    return { length: totalLength, segments, pathDists: pathDist };
}
