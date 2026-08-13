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
 * DNA Structural Validation and Scoring Engine
 */

export function analyzeDNA(graph) {
    const active = graph.cell.active;
    const count = graph.cell.count;
    const name = graph.cell.name;

    // 1. Identify all active base cells (nucleotides)
    const baseIndices = [];
    const baseTypeMap = { 'A': 1, 'T': 2, 'C': 3, 'G': 4 };

    for (let i = 0; i < count; i++) {
        if (active[i] === 1) {
            const baseName = name[i];
            if (baseName === 'A' || baseName === 'T' || baseName === 'C' || baseName === 'G') {
                baseIndices.push(i);
                if (graph.cell.dnaBaseType) {
                    graph.cell.dnaBaseType[i] = baseTypeMap[baseName];
                }
            }
        }
    }

    // 2. Trace strands via covalent connections
    const pred = new Int32Array(count).fill(-1);
    const succ = new Int32Array(count).fill(-1);

    for (const j of baseIndices) {
        const pinStart = graph.cell.pinStart[j];
        if (graph.cell.inputCount[j] > 0) {
            const covalentNet = graph.pin.net[pinStart];
            if (covalentNet >= 2) {
                const i = graph.net.driverCell[covalentNet];
                if (i !== -1 && active[i] === 1 && baseIndices.includes(i)) {
                    pred[j] = i;
                    succ[i] = j;
                    if (graph.net.dnaBondKind) {
                        graph.net.dnaBondKind[covalentNet] = 1; // 1: Covalent
                    }
                }
            }
        }
    }

    // Find start of strands (base cells with no predecessor in baseIndices)
    const starts = baseIndices.filter(i => pred[i] === -1);

    const strands = [];
    const basePosInStrand = new Int32Array(count).fill(-1);

    starts.forEach((start, strandId) => {
        const currStrand = [];
        let curr = start;
        let pos = 0;
        while (curr !== -1) {
            currStrand.push(curr);
            if (graph.cell.dnaStrandId) {
                graph.cell.dnaStrandId[curr] = strandId;
                graph.cell.dnaPolarity[curr] = 1;
            }
            basePosInStrand[curr] = pos;
            pos++;
            curr = succ[curr];
        }
        strands.push(currStrand);
    });

    // 3. Find paired bases via shared HBond nets (hydrogen bonds)
    const hBondGroups = {};
    for (const i of baseIndices) {
        if (graph.cell.inputCount[i] > 1) {
            const pinStart = graph.cell.pinStart[i];
            const pairNet = graph.pin.net[pinStart + 1];
            if (pairNet >= 2) {
                if (!hBondGroups[pairNet]) hBondGroups[pairNet] = [];
                hBondGroups[pairNet].push(i);
                if (graph.net.dnaBondKind) {
                    graph.net.dnaBondKind[pairNet] = 2; // 2: Hydrogen bond
                }
            }
        }
    }

    const pairs = new Int32Array(count).fill(-1);
    for (const netIdx in hBondGroups) {
        const group = hBondGroups[netIdx];
        if (group.length === 2) {
            const u = group[0];
            const v = group[1];
            pairs[u] = v;
            pairs[v] = u;
            if (graph.cell.dnaComplementPartner) {
                graph.cell.dnaComplementPartner[u] = v;
                graph.cell.dnaComplementPartner[v] = u;
            }
        }
    }

    // 4. Scoring and validation checks
    const penalties = [];
    let totalPenalty = 0.0;

    // Reset penalties
    if (graph.cell.dnaPenalty) {
        graph.cell.dnaPenalty.fill(0);
    }

    // Complementarity
    const complements = { 'A': 'T', 'T': 'A', 'C': 'G', 'G': 'C' };
    for (let i = 0; i < baseIndices.length; i++) {
        const u = baseIndices[i];
        const v = pairs[u];
        if (v !== -1 && u < v) {
            const typeU = name[u];
            const typeV = name[v];
            if (complements[typeU] !== typeV) {
                penalties.push(`Complementarity Mismatch: Base #${u} (${typeU}) paired with Base #${v} (${typeV})`);
                totalPenalty += 1.0;
                if (graph.cell.dnaPenalty) {
                    graph.cell.dnaPenalty[u] += 1.0;
                    graph.cell.dnaPenalty[v] += 1.0;
                }
            }
        }
    }

    // Polarity check (Antiparallel alignment)
    for (let i = 0; i < baseIndices.length; i++) {
        const u = baseIndices[i];
        const v = pairs[u];
        if (v !== -1 && u < v) {
            const strandU = graph.cell.dnaStrandId ? graph.cell.dnaStrandId[u] : -1;
            const strandV = graph.cell.dnaStrandId ? graph.cell.dnaStrandId[v] : -1;
            if (strandU !== -1 && strandV !== -1 && strandU !== strandV) {
                const nextU = succ[u];
                if (nextU !== -1 && pairs[nextU] !== -1) {
                    const pairNextU = pairs[nextU];
                    const posV = basePosInStrand[v];
                    const posPairNextU = basePosInStrand[pairNextU];
                    if (posPairNextU > posV) {
                        penalties.push(`Polarity violation: Strand #${strandU} and Strand #${strandV} run parallel near Base #${u}`);
                        totalPenalty += 0.5;
                        if (graph.cell.dnaPenalty) {
                            graph.cell.dnaPenalty[u] += 0.5;
                            graph.cell.dnaPenalty[v] += 0.5;
                        }
                    }
                }
            }
        }
    }

    // Continuity checks
    const isolatedBases = strands.filter(s => s.length === 1);
    if (isolatedBases.length > 0) {
        penalties.push(`Continuity violation: ${isolatedBases.length} isolated single bases detected`);
        totalPenalty += isolatedBases.length * 2.0;
    }

    // Coordinates assignment
    strands.forEach((s, strandId) => {
        s.forEach((baseIdx, pos) => {
            const partner = pairs[baseIdx];
            let hx = 0, hy = 0, hz = pos * 0.34;
            const angle = pos * 0.6;
            const radius = 1.0;

            if (partner !== -1) {
                if (strandId % 2 === 0) {
                    hx = radius * Math.cos(angle);
                    hy = radius * Math.sin(angle);
                } else {
                    hx = radius * Math.cos(angle + Math.PI);
                    hy = radius * Math.sin(angle + Math.PI);
                }
            } else {
                hx = 1.5 * Math.cos(angle);
                hy = 1.5 * Math.sin(angle);
            }

            if (graph.cell.dnaX) {
                graph.cell.dnaX[baseIdx] = hx;
                graph.cell.dnaY[baseIdx] = hy;
                graph.cell.dnaZ[baseIdx] = hz;
            }
        });
    });

    // Steric clash check
    let clashCount = 0;
    for (let i = 0; i < baseIndices.length; i++) {
        for (let j = i + 1; j < baseIndices.length; j++) {
            const u = baseIndices[i];
            const v = baseIndices[j];
            if (pairs[u] !== v) {
                const dx = graph.cell.dnaX ? graph.cell.dnaX[u] - graph.cell.dnaX[v] : 0;
                const dy = graph.cell.dnaY ? graph.cell.dnaY[u] - graph.cell.dnaY[v] : 0;
                const dz = graph.cell.dnaZ ? graph.cell.dnaZ[u] - graph.cell.dnaZ[v] : 0;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (dist < 0.35) {
                    clashCount++;
                    totalPenalty += 1.0;
                    if (graph.cell.dnaPenalty) {
                        graph.cell.dnaPenalty[u] += 1.0;
                        graph.cell.dnaPenalty[v] += 1.0;
                    }
                }
            }
        }
    }
    if (clashCount > 0) {
        penalties.push(`Steric Clash Heuristic: ${clashCount} non-paired base collisions (< 0.35 nm)`);
    }

    const assemblyComplexity = strands.length * 10.0 + baseIndices.length * 0.1;

    return {
        baseCount: baseIndices.length,
        strandsCount: strands.length,
        pairsCount: Object.keys(hBondGroups).length,
        strands,
        pairs,
        penalties,
        totalPenalty,
        assemblyComplexity
    };
}
