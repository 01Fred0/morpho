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
import { compileModule, CompiledGraph } from '../js/compiler.js';
import { performance } from 'perf_hooks';
import { loadMorphoCode } from '../js/utils.js';

const CODE = await loadMorphoCode();

function runFullExpansion(graph, registry, optimize = false) {
    graph.registry = registry;
    for (let i = 0; i < graph.cell.count; i++) {
        while (graph.isExpandable(i)) {
            graph.expandCell(i, optimize);
        }
    }
}

function runBenchmark() {
    const ast = parse(CODE);
    const { registry, createRoot } = compileModule(ast, 'wallace_multiplier', [16, 16]);

    console.log("Warming up JIT...");
    for (let i = 0; i < 100; i++) {
        const g = createRoot();
        runFullExpansion(g, registry, true);
    }

    console.log("Running compiler benchmark (500 iterations)...");
    const start = performance.now();
    for (let i = 0; i < 500; i++) {
        const g = createRoot();
        runFullExpansion(g, registry, true);
    }
    const elapsed = performance.now() - start;
    const avgTime = elapsed / 500;
    console.log(`Average expansion time (16x16 Wallace): ${avgTime.toFixed(3)} ms`);
}

runBenchmark();
