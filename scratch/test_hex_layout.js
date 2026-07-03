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

import { HexLayoutEngine } from '../js/hex_layout.js';

// Minimal mock graph that has cell capacity and active arrays
const mockGraph = {
    cell: {
        capacity: 10,
        count: 0,
        parent: [],
        active: [],
        type: []
    },
    pin: {
        count: 0,
        net: [],
        cell: []
    },
    net: {
        count: 0,
        driverCell: []
    },
    getCellEstimateSize(i) { return 1; },
    isExpandable(i) { return false; },
    expandCell() { return false; }
};

const layout = new HexLayoutEngine(mockGraph);

// Let's manually set a few positions and check results
layout._setNodeGridPos(0, 0, 0);
layout._setNodeGridPos(1, 1, 0); // neighbor along q (stride = 1)
layout._setNodeGridPos(2, 0, 1); // neighbor along r

console.log("Node 0 (q=0, r=0): x =", layout.node.x[0], ", y =", layout.node.y[0]);
console.log("Node 1 (q=1, r=0): x =", layout.node.x[1], ", y =", layout.node.y[1]);
console.log("Node 2 (q=0, r=1): x =", layout.node.x[2], ", y =", layout.node.y[2]);

console.log("x stride (q=1 vs q=0):", layout.node.x[1] - layout.node.x[0]);
console.log("y stride (r=1 vs r=0):", layout.node.y[2] - layout.node.y[0]);
