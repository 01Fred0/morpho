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

import { MaxHeap } from './utils.js';
import { LayoutEngine } from './force_layout.js';

export class Grower {
    constructor(graph, optimize = false, seed = 1337) {
        this.graph = graph;
        this.optimize = optimize;
        this.layout = new LayoutEngine(this.graph, seed);
        this.headIdx = 0;
        this.heap = null;
        this.seed = seed;
    }

    _pushToHeap(cellIdx) {
        const size = this.graph.getCellEstimateSize(cellIdx);
        this.heap.push({ cellIdx, size });
    }

    _initHeap() {
        this.heap = new MaxHeap((a, b) => a.size - b.size);
        for (let i = 0; i < this.graph.cell.count; i++) {
            if (this.graph.isExpandable(i)) {
                this._pushToHeap(i);
            }
        }
    }

    _expandCell(cellIdx) {
        const initialCount = this.graph.cell.count;
        let startCount = initialCount;
        if (!this.graph.expandCell(cellIdx, this.optimize)) {
            return false;
        }

        while (this.graph.cell.count - startCount === 1) {
            const nextIdx = startCount;
            if (!this.graph.isExpandable(nextIdx)) break;
            
            startCount = this.graph.cell.count;
            if (!this.graph.expandCell(nextIdx, this.optimize)) {
                break;
            }
        }

        if (this.heap) {
            for (let i = initialCount; i < this.graph.cell.count; i++) {
                if (this.graph.isExpandable(i)) {
                    this._pushToHeap(i);
                }
            }
        }
        return true;
    }

    expand(method) {
        return method === 'bfs' ? this.expandNext() : this.expandLargest();
    }

    expandNext() {
        while (this.headIdx < this.graph.cell.count) {
            if (this._expandCell(this.headIdx++)) {
                return true;
            }
        }
        return false;
    }

    expandLargest() {
        if (!this.heap) {
            this._initHeap();
        }

        while (this.heap.length > 0) {
            const cellIdx = this.heap.pop().cellIdx;
            if (this.graph.cell.active[cellIdx] === 1 && this.graph.isExpandable(cellIdx)) {
                if (this._expandCell(cellIdx)) {
                    return true;
                }
            }
        }
        return false;
    }

    isFullyExpanded() {
        return this.headIdx >= this.graph.cell.count || (this.heap !== null && this.heap.length === 0);
    }

    relaxLayout(steps = 1) {
        this.layout.relax(steps);
    }
}
