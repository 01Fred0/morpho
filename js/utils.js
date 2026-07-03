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
 * High-Performance Utility Helper Functions
 */

/**
 * Helper to grow a typed array to a new capacity, preserving original values and filling new slots.
 * @param {Uint8Array|Int32Array|Uint32Array} array - The original typed array to grow.
 * @param {number} newCapacity - The target capacity.
 * @param {number} [fillValue] - Optional value to fill the newly allocated section.
 * @returns {Uint8Array|Int32Array|Uint32Array} A new typed array of the specified capacity.
 */
export const growArray = (array, newCapacity, fillValue) => {
    const newArray = new array.constructor(newCapacity);
    if (fillValue !== undefined) {
        newArray.fill(fillValue, array.length);
    }
    newArray.set(array);
    return newArray;
};

/**
 * Struct-of-Arrays (SoA) dynamic typed-array collection wrapper.
 */
export class SoA {
    constructor(schema, initialCapacity, initialCount = 0) {
        this.schema = schema;
        this.capacity = initialCapacity;
        this.count = initialCount;
        for (const [name, [Type, fillValue, multiplier]] of Object.entries(schema)) {
            const mult = multiplier || 1;
            const arr = new Type(initialCapacity * mult);
            if (fillValue !== undefined) {
                arr.fill(fillValue);
            }
            this[name] = arr;
        }
    }
    
    grow(minCapacity) {
        const newCapacity = Math.max(minCapacity, this.capacity * 2);
        for (const [name, [Type, fillValue, multiplier]] of Object.entries(this.schema)) {
            const mult = multiplier || 1;
            this[name] = growArray(this[name], newCapacity * mult, fillValue);
        }
        this.capacity = newCapacity;
    }

    alloc(n = 1) {
        if (this.count + n > this.capacity) {
            this.grow(this.count + n);
        }
        const idx = this.count;
        this.count += n;
        return idx;
    }
}

/**
 * Array helper to construct a mapped list of elements.
 */
export const range = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

/**
 * High-performance MaxHeap binary heap implementation.
 */
export class MaxHeap {
    constructor(compare) {
        this.heap = [];
        this.compare = compare;
    }
    get length() { return this.heap.length; }
    push(item) {
        this.heap.push(item);
        let i = this.heap.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.compare(this.heap[i], this.heap[p]) <= 0) break;
            [this.heap[i], this.heap[p]] = [this.heap[p], this.heap[i]];
            i = p;
        }
    }
    pop() {
        const root = this.heap[0], end = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = end;
            let i = 0, len = this.heap.length;
            while ((i << 1) + 1 < len) {
                let left = (i << 1) + 1, right = left + 1, best = left;
                if (right < len && this.compare(this.heap[right], this.heap[left]) > 0) best = right;
                if (this.compare(this.heap[i], this.heap[best]) >= 0) break;
                [this.heap[i], this.heap[best]] = [this.heap[best], this.heap[i]];
                i = best;
            }
        }
        return root;
    }
}

export async function loadMorphoCode(basePath = '.') {
    let text = '';
    if (typeof window === 'undefined') {
        const fs = await import('fs');
        const path = await import('path');
        text = fs.readFileSync(path.resolve(basePath, 'tiny_morpho.py'), 'utf8');
    } else {
        const resp = await fetch(basePath + '/tiny_morpho.py');
        text = await resp.text();
    }

    const startMarker = '# MORPHO_BEGIN';
    const endMarker = '# MORPHO_END';
    const startIdx = text.indexOf(startMarker);
    const endIdx = text.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1) {
        throw new Error("Could not find MORPHO_BEGIN or MORPHO_END in tiny_morpho.py");
    }
    return text.substring(startIdx + startMarker.length, endIdx).trim();
}

export function mulberry32(a) {
    return function() {
        let t = a += 0x6D2B79F5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}

/**
 * Shuffles an array in-place using Fisher-Yates algorithm.
 * @param {Array|TypedArray} array - The array to shuffle.
 * @param {Function} [randomFn] - Deterministic random function.
 */
export const shuffle = (array, randomFn = Math.random) => {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(randomFn() * (i + 1));
        const temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
};

/**
 * Clamps a number between a minimum and maximum value.
 * @param {number} val - The value to clamp.
 * @param {number} min - The lower bound.
 * @param {number} max - The upper bound.
 * @returns {number} The clamped value.
 */
export const clamp = (val, min, max) => Math.max(min, Math.min(val, max));

/**
 * Loads an external JavaScript file dynamically and returns a Promise.
 * @param {string} src - The URL/path of the script to load.
 * @returns {Promise<Event>} A promise that resolves when the script is loaded successfully.
 */
export const loadScript = (src) => {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
};
