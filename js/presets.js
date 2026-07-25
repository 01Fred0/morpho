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

export const HERO_DESIGNS = [
    {
        key: 'brent_kung',
        design: ['brent_kung_adder', [32, 32, 1]],
        title: 'Brent–Kung Parallel Prefix Adder',
        desc: '32-bit Binary prefix tree topology resolving carries in logarithmic depth O(log N).',
        anchor: '#brent-kung-adder'
    },
    {
        key: 'ripple_adder',
        design: ['ripple_adder', [32, 32, 1]],
        title: 'Ripple-Carry Adder (32-bit)',
        desc: 'Linear carry propagation chain resolving addition bit-by-bit.',
        anchor: '#ripple-carry-adder'
    },
    {
        key: 'wallace',
        design: ['wallace_multiplier', [16, 16]],
        method: 'largest',
        title: 'Wallace Multiplier (16x16-bit)',
        desc: 'Compression tree reducing partial products using 3:2 carry-save adders.',
        anchor: '#recursive-carry-save-multiplier'
    },
    {
        key: 'shifter',
        design: ['right_shifter', [32, 5, 1]],
        method: 'largest',
        title: 'Logarithmic Barrel Shifter (32-bit)',
        desc: 'Cascading multiplexer stages that conditionally shift the bus by powers of two.',
        anchor: '#control-and-shift-logic'
    },
    {
        key: 'triangle_largest',
        design: ['triangle', [32]],
        method: 'largest',
        title: 'Triangle (Largest-First)',
        desc: 'Recursive XOR shell growth with a uniform Largest-First expansion schedule.',
        anchor: '#tail-recursion-growth',
        sim: false
    },
    {
        key: 'triangle_bfs',
        design: ['triangle', [32]],
        method: 'bfs',
        title: 'Triangle (BFS)',
        desc: 'Recursive XOR shell growth with a localized BFS expansion schedule.',
        anchor: '#tail-recursion-growth',
        sim: false
    },    
    {
        key: 'grid2d',
        design: ['grid', [10, 15]],
        method: 'bfs',
        title: '2D Grid (10x15)',
        desc: '2D grid of connections built recursively using axis swapping.',
        anchor: '#2d-grid-and-cell-substitution',
        sim: false
    },
    {
        key: 'grid_skip',
        design: ['grid_skip', [16, 16]],
        method: 'largest',
        title: 'Collapsing Grid',
        desc: 'A 16x16 grid with a pass-through basecase, showcasing pruning and layout collapse.',
        anchor: '#2d-grid-and-cell-substitution',
        sim: false
    },    
    {
        key: 'ring',
        design: ['ring', [20]],
        title: 'Ring Topology',
        desc: 'Connects adjacent bits and closes the loop to form a circular structure.',
        anchor: '#tubes-chains-and-trees',
        sim: false
    },
    {
        key: 'tube',        
        design: ['tube', [10, 15]],
        method: 'largest',
        title: 'Cylindrical Grid (Tube)',
        desc: '10x15 regular loop-closures folded into a tube geometry.',
        anchor: '#tubes-chains-and-trees',
        sim: false
    },
    {
        key: 'chain',
        design: ['chain', [20, 20]],
        method: 'largest',
        title: 'Not-Gate Chains',
        desc: 'Parallel linear cascades of Not gates resolving recursively.',
        anchor: '#tubes-chains-and-trees',
        sim: false
    },
    {
        key: 'tree',
        design: ['tree', [10, 15]],
        title: 'Hierarchical Division Tree',
        desc: 'Branching network of nested cell divisions resembling L-Systems.',
        anchor: '#tubes-chains-and-trees',
        sim: false
    },
    {
        key: 'medusa',
        design: ['medusa', [36, 8]],
        method: 'largest',
        title: 'Medusa',
        desc: 'A complex compound structure combining trees, tubes, and chains into a highly symmetric organic layout.',
        anchor: '#tubes-chains-and-trees',
        sim: false
    }
];

