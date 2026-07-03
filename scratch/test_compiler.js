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

import { parse } from '../js/parser.js';
import { compileModule, CompiledGraph, CELL_TYPES } from '../js/compiler.js';
import { optimizeLUT } from '../js/primitives.js';
import { Grower } from '../js/grower.js';
import { loadMorphoCode } from '../js/utils.js';
import assert from 'assert';

const CODE = await loadMorphoCode();

// Helper: Run systematic unit test
function runTest(name, fn) {
    try {
        fn();
        console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        console.error(`\x1b[31m✗\x1b[0m ${name}`);
        console.error(err.stack);
        process.exit(1);
    }
}

// Invariants Verification Engine
function verifyGraphIntegrity(graph) {
    // 1. Fanout Invariant: sum of net fanouts equals connected pins
    let activePinsCount = 0;
    for (let i = 0; i < graph.pin.count; i++) {
        if (graph.pin.net[i] !== -1) activePinsCount++;
    }
    let sumFanouts = 0;
    for (let i = 0; i < graph.net.count; i++) {
        sumFanouts += graph.net.fanout[i];
    }
    assert.strictEqual(sumFanouts, activePinsCount, `Fanout invariant violated! Sum of fanouts is ${sumFanouts}, but active pins count is ${activePinsCount}.`);

    // 2. Circular Linked-Lists Invariant
    for (let i = 0; i < graph.net.count; i++) {
        const firstPin = graph.net.firstDstPin[i];
        if (firstPin === -1) {
            assert.strictEqual(graph.net.fanout[i], 0, `Net ${i} has firstDstPin = -1, but fanout = ${graph.net.fanout[i]}.`);
            continue;
        }
        let pinIdx = firstPin;
        let count = 0;
        do {
            assert.strictEqual(graph.pin.net[pinIdx], i, `Pin ${pinIdx} is in Net ${i}'s ring, but points to Net ${graph.pin.net[pinIdx]}.`);
            
            const next = graph.pin.nextDst[pinIdx];
            const prev = graph.pin.prevDst[pinIdx];
            
            assert.strictEqual(graph.pin.prevDst[next], pinIdx, `Ring linkage broken: next of ${pinIdx} is ${next}, but prev of ${next} is ${graph.pin.prevDst[next]}.`);
            assert.strictEqual(graph.pin.nextDst[prev], pinIdx, `Ring linkage broken: prev of ${pinIdx} is ${prev}, but next of ${prev} is ${graph.pin.nextDst[prev]}.`);
            
            pinIdx = next;
            count++;
        } while (pinIdx !== firstPin);
        
        assert.strictEqual(count, graph.net.fanout[i], `Net ${i} ring has ${count} pins, but fanout is ${graph.net.fanout[i]}.`);
    }

    // 3. Driver/Pin Invariants for Active Cells
    for (let i = 0; i < graph.cell.count; i++) {
        if (graph.cell.active[i] === 0) continue;
        
        const pinStart = graph.cell.pinStart[i];
        const inputCount = graph.cell.inputCount[i];
        for (let j = 0; j < inputCount; j++) {
            assert.strictEqual(graph.pin.cell[pinStart + j], i, `Pin ${pinStart + j} belongs to Cell ${i}, but pin.cell is ${graph.pin.cell[pinStart + j]}.`);
        }

        if (!graph.isSystemCell(i)) {
            const netStart = graph.cell.netStart[i];
            const outputCount = graph.cell.outputCount[i];
            if (netStart !== -1) {
                for (let j = 0; j < outputCount; j++) {
                    const netIdx = netStart + j;
                    if (graph.net.driverCell[netIdx] !== -1) {
                        assert.strictEqual(graph.net.driverCell[netIdx], i, `Net ${netIdx} output of Cell ${i} driven by Cell ${graph.net.driverCell[netIdx]}.`);
                    }
                }
            }
        }
    }
}

function runFullExpansion(graph, registry, optimize = false) {
    graph.registry = registry;
    for (let i = 0; i < graph.cell.count; i++) {
        while (graph.isExpandable(i)) {
            graph.expandCell(i, optimize);
        }
    }
    verifyGraphIntegrity(graph);
}

// DFS-Based Topological Evaluation Simulator
function getTopologicalOrder(graph) {
    const visited = new Uint8Array(graph.cell.count); // 0: unvisited, 1: visiting, 2: visited
    const order = [];

    function visit(cellIdx) {
        if (visited[cellIdx] === 2) return;
        if (visited[cellIdx] === 1) {
            throw new Error(`Cycle detected in graph!`);
        }
        
        visited[cellIdx] = 1;
        
        const pinStart = graph.cell.pinStart[cellIdx];
        const inputCount = graph.cell.inputCount[cellIdx];
        for (let i = 0; i < inputCount; i++) {
            const netIdx = graph.pin.net[pinStart + i];
            if (netIdx !== -1 && netIdx >= 2) {
                const driverCell = graph.net.driverCell[netIdx];
                if (driverCell !== -1) {
                    visit(driverCell);
                }
            }
        }
        
        visited[cellIdx] = 2;
        order.push(cellIdx);
    }

    if (graph.outputsCellIdx !== -1) {
        visit(graph.outputsCellIdx);
    }
    
    for (let i = 0; i < graph.cell.count; i++) {
        if (graph.cell.active[i] === 1) {
            visit(i);
        }
    }

    return order;
}

function simulate(graph, inputs) {
    const values = new Uint8Array(graph.net.count);
    values[0] = 0;
    values[1] = 1;
    
    graph.inputs.forEach((bus, portIdx) => {
        bus.forEach((netIdx, w) => {
            values[netIdx] = inputs[portIdx][w];
        });
    });
    
    const order = getTopologicalOrder(graph);
    
    for (let i = 0; i < order.length; i++) {
        const cellIdx = order[i];
        if (graph.cell.active[cellIdx] === 0 || !graph.isLut(cellIdx)) continue;
        
        const outputWidth = graph.cell.outputCount[cellIdx];
        const arity = graph.cell.lutArity[cellIdx];
        const lutVal = graph.cell.lutValue[cellIdx];
        const netStart = graph.cell.netStart[cellIdx];
        
        for (let slotIdx = 0; slotIdx < outputWidth; slotIdx++) {
            const outNet = netStart + slotIdx;
            if (graph.net.driverCell[outNet] !== cellIdx) continue;
            
            let addr = 0;
            for (let portIdx = 0; portIdx < arity; portIdx++) {
                const pinIdx = graph.getLutPinIndex(cellIdx, portIdx, slotIdx);
                const inNet = graph.pin.net[pinIdx];
                const val = inNet === -1 ? 0 : values[inNet];
                addr |= val << portIdx;
            }
            values[outNet] = (lutVal >> addr) & 1;
        }
    }
    
    return graph.outputs.map(bus =>
        bus.map(netIdx => values[netIdx])
    );
}

function toBitArray(val, width) {
    const bits = [];
    for (let i = 0; i < width; i++) {
        bits.push(Number((BigInt(val) >> BigInt(i)) & 1n));
    }
    return bits;
}

function fromBitArray(bits) {
    let val = 0n;
    for (let i = 0; i < bits.length; i++) {
        val += BigInt(bits[i]) << BigInt(i);
    }
    return val;
}

// --- SYSTEM TESTS ---

runTest("LUT Optimizations (optimizeLUT unit tests)", () => {
    // And(a, 0) -> Constant 0
    assert.deepStrictEqual(optimizeLUT(0b1000, [5, 0]), [0, 0]);
    // And(a, 1) -> Buffer(a)
    assert.deepStrictEqual(optimizeLUT(0b1000, [5, 1]), [5, 0]);
    // Or(a, 1) -> Constant 1
    assert.deepStrictEqual(optimizeLUT(0b1110, [5, 1]), [1, 0]);
    // And(a, b) -> No replacement, both used
    assert.deepStrictEqual(optimizeLUT(0b1000, [5, 6]), [-1, 3]);
    // Xor3(a, b, 0) -> No replacement, ports 0 and 1 used
    assert.deepStrictEqual(optimizeLUT(0b1001_0110, [5, 6, 0]), [-1, 3]);
    // And(a, -1) -> Constant 0
    assert.deepStrictEqual(optimizeLUT(0b1000, [5, -1]), [0, 0]);
    // Or(a, -1) -> Buffer(a)
    assert.deepStrictEqual(optimizeLUT(0b1110, [5, -1]), [5, 0]);
});

runTest("Mock Optimizations (DCE unit test)", () => {
    const DEAD_CODE = `
    And = LUT(2, 0b1000)
    @morpho
    def test_dce(a, b):
        x = And(a, b)
        y = And(a, b)
        return y
    `;
    const ast = parse(DEAD_CODE);
    const { registry, createRoot } = compileModule(ast, 'test_dce', [1, 1]);
    const graph = createRoot();

    const success = graph.expandCell(2, true);
    assert.strictEqual(success, true);
    assert.strictEqual(graph.cell.count, 6);

    let activeCellCount = 0;
    const activeCells = [];
    for (let i = 0; i < graph.cell.count; i++) {
        if (graph.cell.active[i] === 1) {
            activeCellCount++;
            activeCells.push(graph.cell.name[i]);
        }
    }
    assert.strictEqual(activeCellCount, 4);
    assert.deepStrictEqual(activeCells, ['a', 'b', 'y', 'And']);
    verifyGraphIntegrity(graph);
});

runTest("Multi-Output LUT Splitting unit test", () => {
    const graph = new CompiledGraph();
    graph.pushCell("in0", [], [4], CELL_TYPES.INPUT);
    graph.inputCells.push(graph.cell.count - 1);
    graph.pushCell("in1", [], [4], CELL_TYPES.INPUT);
    graph.inputCells.push(graph.cell.count - 1);
    
    const lutIdx = graph.cell.alloc(1);
    graph.cell.active[lutIdx] = 1;
    graph.cell.type[lutIdx] = CELL_TYPES.LUT;
    graph.cell.name[lutIdx] = "MyLut";
    graph.cell.lutValue[lutIdx] = 0b1000;
    graph.cell.lutArity[lutIdx] = 2;
    graph.cell.outputCount[lutIdx] = 4;
    graph.cell.activeOutputs[lutIdx] = 4;
    
    graph.cell.pinStart[lutIdx] = graph.pin.count;
    graph.cell.inputCount[lutIdx] = 8;
    
    for (let slot = 0; slot < 4; slot++) {
        graph.addPin(lutIdx, graph.inputs[0][slot]);
        graph.addPin(lutIdx, graph.inputs[1][slot]);
    }
    
    const firstNet = graph.net.alloc(4);
    graph.cell.netStart[lutIdx] = firstNet;
    for (let i = 0; i < 4; i++) {
        graph.net.driverCell[firstNet + i] = lutIdx;
        graph.net.name[firstNet + i] = `net_${i}`;
    }
    
    assert.strictEqual(graph.cell.outputCount[lutIdx], 4);
    
    // Case A: Split when all 4 outputs are active.
    let success = graph.expandCell(lutIdx);
    assert.strictEqual(success, true);
    
    const leftIdx = graph.cell.count - 2;
    const rightIdx = graph.cell.count - 1;
    
    assert.strictEqual(graph.cell.active[lutIdx], 0);
    assert.strictEqual(graph.cell.active[leftIdx], 1);
    assert.strictEqual(graph.cell.outputCount[leftIdx], 2);
    assert.strictEqual(graph.cell.active[rightIdx], 1);
    assert.strictEqual(graph.cell.outputCount[rightIdx], 2);
    
    assert.strictEqual(graph.net.driverCell[firstNet], leftIdx);
    assert.strictEqual(graph.net.driverCell[firstNet + 1], leftIdx);
    assert.strictEqual(graph.net.driverCell[firstNet + 2], rightIdx);
    assert.strictEqual(graph.net.driverCell[firstNet + 3], rightIdx);
    
    // Case B: Split the left cell when its right output is dead (net_1).
    graph.net.driverCell[firstNet + 1] = -1;
    graph.cell.activeOutputs[leftIdx] = 1;
    
    let preCount = graph.cell.count;
    success = graph.expandCell(leftIdx);
    assert.strictEqual(success, true);
    assert.strictEqual(graph.cell.count, preCount + 1);
    
    const leftLeftIdx = graph.cell.count - 1;
    assert.strictEqual(graph.cell.active[leftIdx], 0);
    assert.strictEqual(graph.cell.active[leftLeftIdx], 1);
    assert.strictEqual(graph.cell.outputCount[leftLeftIdx], 1);
    assert.strictEqual(graph.net.driverCell[firstNet], leftLeftIdx);
    assert.strictEqual(graph.net.driverCell[firstNet + 1], -1);
    
    verifyGraphIntegrity(graph);
});

runTest("Mux Compiler Expansion (Mux2 Fallback Oracle)", () => {
    const ast = parse(CODE);
    const { registry, createRoot } = compileModule(ast, 'mux', [8, 3]);

    const testGraph = createRoot();
    runFullExpansion(testGraph, registry);
    
    // Validate output mapping logic for mux
    for (let select = 0; select < 8; select++) {
        const selBits = toBitArray(select, 3);
        const inputBits = toBitArray(0b10101010, 8); // x = 0b10101010
        const simOut = simulate(testGraph, [inputBits, selBits]);
        const computed = simOut[0][0];
        const expected = (0b10101010 >> select) & 1;
        assert.strictEqual(computed, expected, `Mux failed for select ${select}!`);
    }
});

runTest("Wallace Multiplier (4x4) Exhaustive Correctness Oracle", () => {
    const parsed = parse(CODE);
    const { registry, createRoot } = compileModule(parsed, 'wallace_multiplier', [4, 4], true);
    const pristine = createRoot();
    runFullExpansion(pristine, registry, true);

    // Assert optimized counts for 4x4 wallace
    let activeCellCount = 0;
    const activeGateCount = {};
    for (let i = 0; i < pristine.cell.count; i++) {
        if (pristine.cell.active[i] === 1) {
            activeCellCount++;
            activeGateCount[pristine.cell.name[i]] = (activeGateCount[pristine.cell.name[i]] || 0) + 1;
        }
    }
    assert.strictEqual(activeCellCount, 64);

    // Exhaustively simulate all 256 products (0..15 * 0..15)
    for (let a = 0; a < 16; a++) {
        for (let b = 0; b < 16; b++) {
            const inA = toBitArray(a, 4);
            const inB = toBitArray(b, 4);
            const simOut = simulate(pristine, [inA, inB]);
            const computed = fromBitArray(simOut[0]);
            const expected = BigInt(a) * BigInt(b);
            assert.strictEqual(computed, expected, `Wallace Oracle failed for ${a} * ${b}!`);
        }
    }
});

runTest("Brent-Kung Adder (8-bit) Correctness Oracle", () => {
    const ast = parse(CODE);
    const { registry, createRoot } = compileModule(ast, 'brent_kung_adder', [8, 8, 1]);
    const graph = createRoot();
    runFullExpansion(graph, registry, true);

    // Fuzz random additions
    for (let iter = 0; iter < 1000; iter++) {
        const a = Math.floor(Math.random() * 256);
        const b = Math.floor(Math.random() * 256);
        const cin = Math.floor(Math.random() * 2);

        const inA = toBitArray(a, 8);
        const inB = toBitArray(b, 8);
        const inCin = [cin];

        const simOut = simulate(graph, [inA, inB, inCin]);
        const computedSum = fromBitArray(simOut[0]);
        const computedCout = simOut[1][0];

        const expectedTotal = BigInt(a) + BigInt(b) + BigInt(cin);
        const computedTotal = computedSum + (BigInt(computedCout) << 8n);

        assert.strictEqual(computedTotal, expectedTotal, `Brent-Kung failed for ${a} + ${b} + ${cin}!`);
    }
});

runTest("Wallace Multiplier (16x16) Structural Integrity and Gate Gold-Standard", () => {
    const ast = parse(CODE);
    const { registry, createRoot } = compileModule(ast, 'wallace_multiplier', [16, 16]);
    const graph = createRoot();
    runFullExpansion(graph, registry, true);
    
    // Assert physical table sizes matching optimized Wallace 16 metrics
    assert.strictEqual(graph.cell.count, 1934);
    assert.strictEqual(graph.pin.count, 6315);
    assert.strictEqual(graph.net.count, 3711);

    // Gate Breakdown assertions
    let activeCellCount = 0;
    let lutWiresCount = 0;
    const gateBreakdown = {};
    for (let i = 0; i < graph.cell.count; i++) {
        if (graph.cell.active[i] === 0) continue;
        activeCellCount++;
        if (graph.isLut(i)) {
            const name = graph.cell.name[i];
            const cnt = graph.cell.activeOutputs[i];
            lutWiresCount += cnt;
            gateBreakdown[name] = (gateBreakdown[name] || 0) + cnt;
        }
    }
    assert.strictEqual(activeCellCount, 936);
    assert.strictEqual(lutWiresCount, 872);
    assert.deepStrictEqual(gateBreakdown, { carry_op: 41, And: 298, Xor3: 242, Maj3: 242, Xor: 49 });
});

runTest("Grower - expandNext (Linear) vs expandLargest (Heap-based)", () => {
    const ast = parse(CODE);
    const { registry, createRoot } = compileModule(ast, 'wallace_multiplier', [16, 16]);

    // 1. Expand using expandNext
    const graph1 = createRoot();
    const grower1 = new Grower(graph1, true);
    while (grower1.expandNext()) {
        // keep growing until done
    }
    grower1.relaxLayout(1);
    assert.strictEqual(graph1.cell.count, 1934);
    verifyGraphIntegrity(graph1);

    // 2. Expand using expandLargest
    const graph2 = createRoot();
    const grower2 = new Grower(graph2, true);
    while (grower2.expandLargest()) {
        // keep growing until done
    }
    grower2.relaxLayout(1);
    assert.strictEqual(graph2.cell.count, 1934);
    verifyGraphIntegrity(graph2);
});

runTest("Fanout Buffer Insertion and Integrity", () => {
    const ast = parse(CODE);
    
    // Test 1: Compile Brent-Kung adder with fanout insertion enabled
    const { registry, createRoot } = compileModule(ast, 'brent_kung_adder', [8, 8, 1], true, 4);
    const graph = createRoot();
    runFullExpansion(graph, registry, true);
    
    // Verify graph invariants first
    verifyGraphIntegrity(graph);
    
    // Verify fanout constraints:
    // - All active cells must have output nets with fanout <= 5 (threshold 6)
    for (let i = 0; i < graph.cell.count; i++) {
        if (graph.cell.active[i] === 0) continue;
        const maxAllowed = 5;
        const netStart = graph.cell.netStart[i];
        const outCount = graph.cell.outputCount[i];
        if (netStart !== -1) {
            for (let j = 0; j < outCount; j++) {
                const fanout = graph.net.fanout[netStart + j];
                assert.ok(fanout <= maxAllowed, `Cell ${i} (${graph.cell.name[i]}) has net with fanout ${fanout} which exceeds max of ${maxAllowed}!`);
            }
        }
    }
    
    // Simulate additions and check correctness
    for (let iter = 0; iter < 100; iter++) {
        const a = Math.floor(Math.random() * 256);
        const b = Math.floor(Math.random() * 256);
        const cin = Math.floor(Math.random() * 2);

        const inA = toBitArray(a, 8);
        const inB = toBitArray(b, 8);
        const inCin = [cin];

        const simOut = simulate(graph, [inA, inB, inCin]);
        const computedSum = fromBitArray(simOut[0]);
        const computedCout = simOut[1][0];

        const expectedTotal = BigInt(a) + BigInt(b) + BigInt(cin);
        const computedTotal = computedSum + (BigInt(computedCout) << 8n);

        assert.strictEqual(computedTotal, expectedTotal, `Brent-Kung with fanout failed for ${a} + ${b} + ${cin}!`);
    }

    // Test 2: Test custom splitFactor of 2
    const { createRoot: createRoot2 } = compileModule(ast, 'brent_kung_adder', [8, 8, 1], true, null);
    const graph2 = createRoot2();
    runFullExpansion(graph2, registry, true);
    
    // Run buffer insertion with maxFanout = 2
    graph2.maxFanout = 2;
    runFullExpansion(graph2, registry, true);
    
    verifyGraphIntegrity(graph2);
    
    // Check that maximum fanout for any cell is <= 2
    for (let i = 0; i < graph2.cell.count; i++) {
        if (graph2.cell.active[i] === 0) continue;
        const maxAllowed = 2;
        const netStart = graph2.cell.netStart[i];
        const outCount = graph2.cell.outputCount[i];
        if (netStart !== -1) {
            for (let j = 0; j < outCount; j++) {
                const fanout = graph2.net.fanout[netStart + j];
                assert.ok(fanout <= maxAllowed, `Cell ${i} (${graph2.cell.name[i]}) has net with fanout ${fanout} which exceeds max of ${maxAllowed}!`);
            }
        }
    }

    // Run optimize on it, and verify that fanout limits are STILL respected (i.e. optimizer didn't bypass them)
    graph2.optimize();
    verifyGraphIntegrity(graph2);
    
    for (let i = 0; i < graph2.cell.count; i++) {
        if (graph2.cell.active[i] === 0) continue;
        const maxAllowed = 2;
        const netStart = graph2.cell.netStart[i];
        const outCount = graph2.cell.outputCount[i];
        if (netStart !== -1) {
            for (let j = 0; j < outCount; j++) {
                const fanout = graph2.net.fanout[netStart + j];
                assert.ok(fanout <= maxAllowed, `After optimization: Cell ${i} (${graph2.cell.name[i]}) has net with fanout ${fanout} which exceeds max of ${maxAllowed}!`);
            }
        }
    }

    // Simulate additions and check correctness after splitFactor = 2 and optimize
    for (let iter = 0; iter < 100; iter++) {
        const a = Math.floor(Math.random() * 256);
        const b = Math.floor(Math.random() * 256);
        const cin = Math.floor(Math.random() * 2);

        const inA = toBitArray(a, 8);
        const inB = toBitArray(b, 8);
        const inCin = [cin];

        const simOut = simulate(graph2, [inA, inB, inCin]);
        const computedSum = fromBitArray(simOut[0]);
        const computedCout = simOut[1][0];

        const expectedTotal = BigInt(a) + BigInt(b) + BigInt(cin);
        const computedTotal = computedSum + (BigInt(computedCout) << 8n);

        assert.strictEqual(computedTotal, expectedTotal, `Brent-Kung splitFactor 2 failed for ${a} + ${b} + ${cin}!`);
    }
});

runTest("Wallace Multiplier (16x16) Linear Growth with Fanout Buffering", () => {
    const ast = parse(CODE);
    const { registry, createRoot } = compileModule(ast, 'wallace_multiplier', [16, 16], true, 4);
    const graph = createRoot();
    const grower = new Grower(graph, true);
    while (grower.expandNext()) {
        // grow
    }
    
    verifyGraphIntegrity(graph);
    
    // Check that no cell has fanout > 4
    for (let i = 0; i < graph.cell.count; i++) {
        if (graph.cell.active[i] === 0) continue;
        const maxAllowed = 4;
        const netStart = graph.cell.netStart[i];
        const outCount = graph.cell.outputCount[i];
        if (netStart !== -1) {
            for (let j = 0; j < outCount; j++) {
                const fanout = graph.net.fanout[netStart + j];
                assert.ok(fanout <= maxAllowed, `Cell ${i} (${graph.cell.name[i]}) has net with fanout ${fanout} exceeding max of ${maxAllowed}!`);
            }
        }
    }
});

runTest("Medusa Compilation and Slicing Oracle", () => {
    const parsed = parse(CODE);
    const { registry, createRoot } = compileModule(parsed, 'medusa', [36, 8], true);
    const pristine = createRoot();
    runFullExpansion(pristine, registry, true);

    verifyGraphIntegrity(pristine);
    
    // Check that we have exactly 2 output ports of width 36 each
    assert.strictEqual(pristine.outputs.length, 2);
    assert.strictEqual(pristine.outputs[0].length, 36);
    assert.strictEqual(pristine.outputs[1].length, 36);
});

console.log("\n\x1b[32m✔ All systematic test groups passed successfully!\x1b[0m\n");
