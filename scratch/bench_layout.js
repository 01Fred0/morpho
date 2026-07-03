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
import { compileModule } from '../js/compiler.js';
import { Grower } from '../js/grower.js';
import { loadMorphoCode } from '../js/utils.js';
import { solveShortestPathTree } from '../js/hex_layout.js';
import { performance } from 'perf_hooks';
import fs from 'fs';

// Editable parameters
const DESIGNS = [
    ['wallace_multiplier', [16, 16]],
    ['ripple_adder',   [32, 32, 1]],
    ['brent_kung_adder',   [32, 32, 1]],
    ['right_shifter',   [32, 5, 1]],
    ['triangle',   [32]],
];
const INTERMEDIATE_RELAX_STEPS = 10;
const FINAL_RELAX_STEPS = 500;



function computeTotalWireLength(graph, grower) {
    let totalL1 = 0;
    const active = graph.cell.active;
    const x = grower.layout.node.x;
    const y = grower.layout.node.y;

    for (let netIdx = 0; netIdx < graph.net.count; netIdx++) {
        const driver = graph.net.driverCell[netIdx];
        if (driver === -1 || active[driver] === 0) continue;

        const terminals = [];
        terminals.push(driver);

        const pStart = graph.net.firstDstPin[netIdx];
        if (pStart !== -1) {
            let curr = pStart;
            do {
                const dstCell = graph.pin.cell[curr];
                if (dstCell !== -1 && active[dstCell] === 1) {
                    terminals.push(dstCell);
                }
                curr = graph.pin.nextDst[curr];
            } while (curr !== pStart && curr !== -1);
        }

        const uniqueTerminals = Array.from(new Set(terminals));
        if (uniqueTerminals.length <= 1) continue;

        const points = uniqueTerminals.map(cIdx => ({ x: x[cIdx], y: y[cIdx] }));
        const tree = solveShortestPathTree(points);
        totalL1 += tree.length;
    }
    return totalL1;
}

function saveLayoutAsSVG(graph, grower, filepath) {
    const active = graph.cell.active;
    const x = grower.layout.node.x;
    const y = grower.layout.node.y;
    const r = grower.layout.node.r;
    const count = graph.cell.count;

    // 1. Calculate topological depth of all active cells using Kahn's algorithm BFS
    const inDegree = new Int32Array(count);
    const depth = new Float32Array(count);

    for (let i = 0; i < count; i++) {
        if (active[i] === 0) continue;
        if (graph.cell.type[i] === 1) { // CELL_TYPES.INPUT = 1
            inDegree[i] = 0;
            continue;
        }

        let incomingDrivers = 0;
        const pStart = graph.cell.pinStart[i];
        const inputCount = graph.cell.inputCount[i];
        for (let p = 0; p < inputCount; p++) {
            const pinIdx = pStart + p;
            const netIdx = graph.pin.net[pinIdx];
            if (netIdx !== -1) {
                const driver = graph.net.driverCell[netIdx];
                if (driver !== -1 && active[driver] === 1) {
                    incomingDrivers++;
                }
            }
        }
        inDegree[i] = incomingDrivers;
    }


    const queue = [];
    for (let i = 0; i < count; i++) {
        if (active[i] === 1 && inDegree[i] === 0) {
            queue.push(i);
            depth[i] = 0;
        }
    }

    let head = 0;
    while (head < queue.length) {
        const u = queue[head++];
        const currentDepth = depth[u];

        const netStart = graph.cell.netStart[u];
        const outputCount = graph.cell.outputCount[u];
        if (netStart !== -1) {
            for (let n = 0; n < outputCount; n++) {
                const netIdx = netStart + n;
                const pStart = graph.net.firstDstPin[netIdx];
                if (pStart === -1) continue;

                // Collect terminals to run shortest path tree routing
                const terminals = [u];
                let curr = pStart;
                do {
                    const dstCell = graph.pin.cell[curr];
                    if (dstCell !== -1 && active[dstCell] === 1) {
                        terminals.push(dstCell);
                    }
                    curr = graph.pin.nextDst[curr];
                } while (curr !== pStart && curr !== -1);

                const uniqueTerminals = Array.from(new Set(terminals));
                if (uniqueTerminals.length <= 1) continue;

                const points = uniqueTerminals.map(cIdx => ({ x: x[cIdx], y: y[cIdx] }));
                const tree = solveShortestPathTree(points);

                for (let k = 1; k < uniqueTerminals.length; k++) {
                    const dst = uniqueTerminals[k];
                    const pathDist = tree.pathDists[k];
                    const delay = 0.2 + 0.25 * pathDist;

                    if (currentDepth + delay > depth[dst]) {
                        depth[dst] = currentDepth + delay;
                    }

                    inDegree[dst]--;
                    if (inDegree[dst] === 0) {
                        queue.push(dst);
                    }
                }
            }
        }
    }

    let maxDepth = 1;
    for (let i = 0; i < count; i++) {
        if (active[i] === 1 && depth[i] > maxDepth) {
            maxDepth = depth[i];
        }
    }

    let xMin = Infinity, xMax = -Infinity;
    let yMin = Infinity, yMax = -Infinity;

    for (let i = 0; i < count; i++) {
        if (active[i] === 0) continue;
        const px = x[i];
        const py = y[i];
        if (px < xMin) xMin = px;
        if (px > xMax) xMax = px;
        if (py < yMin) yMin = py;
        if (py > yMax) yMax = py;
    }

    const dx = xMax - xMin;
    const dy = yMax - yMin;
    const margin = Math.max(dx, dy) * 0.05 || 1.0;

    const svgWidth = 1000;
    const svgHeight = 1000;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${xMin - margin} ${yMin - margin} ${dx + margin * 2} ${dy + margin * 2}" width="${svgWidth}" height="${svgHeight}">\n`;
    svg += `  <style>\n`;
    svg += `    @keyframes pulse {\n`;
    svg += `      0% { fill: var(--bg); stroke: var(--bg); stroke-width: 0.03; }\n`;
    svg += `      5% { fill: var(--glow); stroke: #ffffff; stroke-width: 0.07; }\n`;
    svg += `      10% { fill: var(--bg); stroke: var(--bg); stroke-width: 0.03; }\n`;
    svg += `      100% { fill: var(--bg); stroke: var(--bg); stroke-width: 0.03; }\n`;
    svg += `    }\n`;
    svg += `    @keyframes wire-pulse {\n`;
    svg += `      0% { stroke-dashoffset: 0; stroke: #20242f; stroke-width: 0.05; }\n`;
    svg += `      6% { stroke: #6366f1; stroke-width: 0.11; }\n`;
    svg += `      14% { stroke-dashoffset: -2; stroke: #20242f; stroke-width: 0.05; }\n`;
    svg += `      100% { stroke-dashoffset: -2; stroke: #20242f; stroke-width: 0.05; }\n`;
    svg += `    }\n`;
    svg += `    .node-anim {\n`;
    svg += `      animation: pulse 4s infinite both;\n`;
    svg += `    }\n`;
    svg += `    .wire-anim {\n`;
    svg += `      stroke-dasharray: 0.4, 0.4;\n`;
    svg += `      animation: wire-pulse 4s infinite linear both;\n`;
    svg += `    }\n`;
    svg += `  </style>\n`;
    svg += `  <rect x="${xMin - margin}" y="${yMin - margin}" width="${dx + margin * 2}" height="${dy + margin * 2}" fill="#0b0f19"/>\n`;

    // 1. Draw nodes
    svg += `  <g stroke-linecap="round" stroke-linejoin="round">\n`;
    for (let i = 0; i < count; i++) {
        if (active[i] === 0) continue;
        const px = x[i];
        const py = y[i];
        const pr = r[i];

        const type = graph.cell.type[i];
        const isExpandable = graph.isExpandable(i);

        let bg = 'hsl(140, 20%, 25%)';
        let glow = 'hsl(140, 90%, 55%)';
        if (type === 1) { // CELL_TYPES.INPUT
            bg = 'hsl(210, 25%, 28%)';
            glow = 'hsl(205, 100%, 60%)';
        } else if (type === 2) { // CELL_TYPES.OUTPUT
            bg = 'hsl(350, 25%, 28%)';
            glow = 'hsl(350, 100%, 60%)';
        } else if (isExpandable) {
            bg = 'hsl(45, 25%, 26%)';
            glow = 'hsl(45, 100%, 58%)';
        }

        const dVal = Math.max(0, depth[i]);
        const delay = (dVal / maxDepth) * 2.5;

        svg += `    <circle cx="${px}" cy="${py}" r="${pr}" class="node-anim" style="--bg: ${bg}; --glow: ${glow}; animation-delay: ${delay.toFixed(2)}s;"/>\n`;
    }
    svg += `  </g>\n`;

    // 2. Draw connections (wires)
    svg += `  <g stroke="#20242f" stroke-width="0.05" stroke-linecap="round">\n`;
    for (let netIdx = 0; netIdx < graph.net.count; netIdx++) {
        const driver = graph.net.driverCell[netIdx];
        if (driver === -1 || active[driver] === 0) continue;

        const terminals = [driver];
        const pStart = graph.net.firstDstPin[netIdx];
        if (pStart !== -1) {
            let curr = pStart;
            do {
                const dstCell = graph.pin.cell[curr];
                if (dstCell !== -1 && active[dstCell] === 1) {
                    terminals.push(dstCell);
                }
                curr = graph.pin.nextDst[curr];
            } while (curr !== pStart && curr !== -1);
        }

        const uniqueTerminals = Array.from(new Set(terminals));
        if (uniqueTerminals.length <= 1) continue;

        const points = uniqueTerminals.map(cIdx => ({ x: x[cIdx], y: y[cIdx] }));
        const tree = solveShortestPathTree(points);

        for (const segment of tree.segments) {
            const [p1, p2] = segment;
            const segmentStartDepth = Math.max(0, depth[driver]) + 0.25 * segment.d1;
            const segmentDelay = (segmentStartDepth / maxDepth) * 2.5;
            svg += `    <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" class="wire-anim" style="animation-delay: ${segmentDelay.toFixed(2)}s;"/>\n`;
        }
    }
    svg += `  </g>\n`;
    svg += `</svg>\n`;

    fs.writeFileSync(filepath, svg);
    console.log(`Saved final layout visualization to ${filepath}`);
}

async function runAllBenchmarks() {
    const code = await loadMorphoCode();
    const ast = parse(code);

    for (const [designName, designArgs] of DESIGNS) {
        console.log(`\n==================================================`);
        console.log(`Starting Layout Benchmark for ${designName} (${designArgs.join(', ')})...`);
        console.log(`==================================================`);
        const startTime = performance.now();

        const { registry, createRoot } = compileModule(ast, designName, designArgs);
        const graph = createRoot();
        const grower = new Grower(graph, true, 'hex'); // Hex layout

        let stepIndex = 0;
        while (true) {
            const cellCount = graph.cell.count;
            const success = grower.expandLargest();
            if (!success) {
                console.log(`Step ${stepIndex.toString().padStart(3, ' ')}: Cells = ${cellCount.toString().padStart(4, ' ')} | Expansion completed (no more cells).`);
                break;
            }

            stepIndex++;

            if (INTERMEDIATE_RELAX_STEPS > 0) {
                grower.relaxLayout(INTERMEDIATE_RELAX_STEPS);
            }
            console.log(`Step ${(stepIndex - 1).toString().padStart(3, ' ')}: Cells = ${cellCount.toString().padStart(4, ' ')}`);
        }

        // Run final relaxation steps
        if (FINAL_RELAX_STEPS > 0) {
            console.log(`Running final ${FINAL_RELAX_STEPS} relaxation steps...`);
            grower.relaxLayout(FINAL_RELAX_STEPS);
        }

        // Save final layout to design-specific SVG
        const filepath = `scratch/${designName}.svg`;
        saveLayoutAsSVG(graph, grower, filepath);

        const duration = performance.now() - startTime;
        console.log(`Layout benchmark for ${designName} completed in ${duration.toFixed(2)} ms.`);
    }
}

runAllBenchmarks().catch(err => {
    console.error(err);
});
