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

import { getNumericValue } from './parser.js';
import { clamp } from './utils.js';

function resolveBound(str, isEnd, step, len) {
    if (str === null) return isEnd ? (step > 0 ? len : -1) : (step > 0 ? 0 : len - 1);
    let val = parseInt(str, 10);
    if (val < 0) val += len;
    return clamp(val, isEnd ? -1 : 0, len);
}

function sliceArray(arr, startStr, endStr, stepStr) {
    const step = parseInt(stepStr, 10) || 1;
    const len = arr.length;
    const start = resolveBound(startStr, false, step, len);
    const end = resolveBound(endStr, true, step, len);

    const res = [];
    for (let i = start; step > 0 ? i < end : i > end; i += step) {
        res.push(arr[i]);
    }
    return res;
}

const PRIMITIVES = {
    SPLIT(args, resolve) {
        const w = resolve(args[0]);
        if (w.length < 2) return null;
        const half = Math.floor(w.length / 2);
        return [w.slice(0, half), w.slice(half)];
    },
    CAT(args, resolve) {
        return [args.flatMap(resolve)];
    },
    REPEAT(args, resolve) {
        const wx = resolve(args[0]);
        const wref = resolve(args[1]);
        return [Array(wref.length).fill(wx).flat()];
    },
    LSLICE(args, resolve) {
        const [wx, wref] = args.map(resolve);
        return wx.length >= wref.length ? [wx.slice(0, wref.length), wx.slice(wref.length)] : null;
    },
    HSLICE(args, resolve) {
        const [wx, wref] = args.map(resolve);
        return wx.length >= wref.length ? [wx.slice(0, wx.length - wref.length), wx.slice(wx.length - wref.length)] : null;
    },
    INDEX(args, resolve) {
        const wx = resolve(args[0]);
        let idx = getNumericValue(args[1]);
        if (idx === null) return null;
        if (idx < 0) idx += wx.length;
        return idx >= 0 && idx < wx.length ? [[wx[idx]]] : null;
    },
    SLICE(args, resolve) {
        const wx = resolve(args[0]);
        return [sliceArray(wx, args[1], args[2], args[3])];
    }
};

function transform_lut(arity, lut, insertPos, getVal) {
    let newLut = 0;
    const mask = (1 << insertPos) - 1;
    const limit = 1 << (arity - 1);
    for (let idx = 0; idx < limit; idx++) {
        const val = getVal(idx);
        const low = idx & mask;
        const high = idx - low;
        const fullIdx = low | (val << insertPos) | (high << 1);
        newLut |= (((lut >> fullIdx) & 1) << idx);
    }
    return newLut;
}

const fixLutCache = new Map();
function fix_lut_input(arity, lut, i, val) {
    const key = `${arity},${lut},${i},${val}`;
    if (fixLutCache.has(key)) return fixLutCache.get(key);
    const res = transform_lut(arity, lut, i, () => val);
    fixLutCache.set(key, res);
    return res;
}

const mergeLutCache = new Map();
function merge_lut_inputs(arity, lut, i, j) {
    const key = `${arity},${lut},${i},${j}`;
    if (mergeLutCache.has(key)) return mergeLutCache.get(key);
    const first = Math.min(i, j), second = Math.max(i, j);
    const res = transform_lut(arity, lut, second, idx => (idx >> first) & 1);
    mergeLutCache.set(key, res);
    return res;
}


const MASKS = [0xaaaaaaaa, 0xcccccccc, 0xf0f0f0f0, 0xff00ff00, 0xffff0000];

/**
 * Optimizes a LUT cell by removing constant/duplicate inputs, pruning unused
 * inputs, and detecting if the LUT collapses to a constant value or a buffer wire.
 * 
 * @param {number} lut - The original truth table value (up to 32 bits).
 * @param {number[]} wires - Original input wire indices for each port of the LUT.
 * @returns {[number, number]} [replacementWire, externalUseMask]
 *   - replacementWire: Bypassing wire index (>= 0), or -1 if the gate must be kept.
 *   - externalUseMask: Bitmask representing which original ports of the cell are still active.
 */
function optimizeLUT(lut, wires) {
    const map = [0, 1];
    const wn = wires.length;
    const reindexed = [];
    
    // 1. Reindex inputs: map constants (0, 1) and disconnected inputs (< 0)
    // to themselves/constant 0, and unique active wires to contiguous indices starting at 2.
    for (let k = 0; k < wn; ++k) {
        let w = wires[k];
        if (w < 0) w = 0; // Treat disconnected inputs as constant 0
        if (w <= 1) {
            reindexed.push(w);
            continue;
        }
        const idx = map.indexOf(w);
        reindexed.push(idx !== -1 ? idx : map.push(w) - 1);
    }
    const activeWireN = map.length - 2;
    let activeLut = 0;
    
    // 2. Re-evaluate truth table for the unique active variables.
    for (let i = 0; i < (1 << activeWireN); ++i) {
        let x = 0;
        for (let k = 0; k < wn; ++k) {
            const w = reindexed[k];
            const bit = w <= 1 ? w : (i >> (w - 2)) & 1;
            x |= bit << k;
        }
        activeLut |= ((lut >> x) & 1) << i;
    }

    // 3. Test each active input variable to see if it is actually used.
    let useMask = 0, useCount = 0, lastUsed = -1;
    for (let i = 0; i < activeWireN; ++i) {
        const shift = 1 << i;
        // If high and low halves match, the output is independent of input i (unused).
        if ((((activeLut<<shift) ^ activeLut) & MASKS[i]) !== 0) {
            useMask |= shift;
            useCount += 1;
            lastUsed = i;
        }
    }
    
    // 4. Collapse to constant if no variables are used.
    if (useCount == 0) {
        return [activeLut & 1, 0]; 
    }
    
    // 5. Collapse to buffer if only 1 variable is used and truth table matches identity.
    const tableMask = activeWireN === 5 ? 0xffffffff : (1 << (1 << activeWireN)) - 1;
    if (useCount == 1 && activeLut === (MASKS[lastUsed] & tableMask)) {
        return [wires[reindexed.indexOf(2 + lastUsed)], 0]; 
    }
    
    // 6. Otherwise keep the gate and build the active port mask for consumers.
    let externalUseMask = 0;
    for (let i = 0; i < wn; ++i) {
        const w = reindexed[i];
        const used = w > 1 ? (useMask >> (w - 2)) & 1 : 0;
        externalUseMask |= used << i;
    }
    return [-1, externalUseMask];
}


export {
    PRIMITIVES,
    sliceArray,
    getNumericValue,
    transform_lut,
    fix_lut_input,
    merge_lut_inputs,
    optimizeLUT
};
