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
 * MorphoHDL WebGL Layout Renderer
 * Shared WebGL/SwissGL rendering machinery: the LayoutRenderer shader pipeline,
 * GPU buffer packing for live CompiledGraphs, and the cell legend overlay.
 * Static article figures (precomputed JSON layouts) live in figures.js.
 */

export const CELL_STYLES = {
    '__INPUTS__': { rgb: [0.2, 0.604, 0.941], label: 'I', name: 'Input' },
    '__OUTPUTS__': { rgb: [1.0, 0.42, 0.42], label: 'O', name: 'Output' },
    '__EXPANDABLE__': { rgb: [0.98, 0.69, 0.02], label: '', name: 'Morpho' },
    'And': { rgb: [0.318, 0.812, 0.4], label: '&', name: 'AND' },
    'Or': { rgb: [0.988, 0.769, 0.098], label: '|', name: 'OR' },
    'Xor': { rgb: [0.8, 0.365, 0.91], label: '^', name: 'XOR' },
    'Xor3': { rgb: [0.518, 0.369, 0.969], label: '^', name: 'XOR3' },
    'Maj3': { rgb: [1.0, 0.573, 0.169], label: 'M3', name: 'Maj3' },
    'carry_op': { rgb: [0.133, 0.722, 0.812], label: 'C', name: 'Carry' },
    'BUF': { rgb: [0.55, 0.6, 0.68], label: 'B', name: 'Buffer', scale: 0.5 },
    'Mux2': { rgb: [0.15, 0.75, 0.45], label: 'Y', name: 'Mux2' },
    'Not': { rgb: [0.95, 0.25, 0.55], label: '~', name: 'NOT' },
    'A': { rgb: [0.1, 0.7, 0.3], label: 'A', name: 'Adenine' },
    'T': { rgb: [0.9, 0.2, 0.2], label: 'T', name: 'Thymine' },
    'C': { rgb: [0.2, 0.4, 0.9], label: 'C', name: 'Cytosine' },
    'G': { rgb: [0.9, 0.7, 0.1], label: 'G', name: 'Guanine' },
    'HBond': { rgb: [0.6, 0.6, 0.6], label: 'H', name: 'H-Bond', scale: 0.5 }
};

import { CELL_TYPES } from './compiler.js';

export const TIMING_CONFIG = {
    pulseDuration: 0.35,      // seconds, width of signal pulse wave
    fadeDuration: 0.5,        // seconds, transition from fully lit to base state
    pauseDuration: 2.0,       // seconds, hold fully-lit state before new wave
    defaultTStep: 0.45        // seconds per topological depth step (default)
};

export const MAX_GL_NODES = 1 << 16;
export const MAX_GL_LINKS = 1 << 18;

const maxOffsets = 1024;
export const netOffsetsX = new Float32Array(maxOffsets);
export const netOffsetsY = new Float32Array(maxOffsets);
for (let i = 0; i < maxOffsets; i++) {
    const theta = i * 2.3999632297286533;
    const r = 0.05 * Math.sqrt(i);
    netOffsetsX[i] = r * Math.cos(theta);
    netOffsetsY[i] = r * Math.sin(theta);
}

export const GRAPH_BG_COLOR = [0.043, 0.059, 0.098, 1.0];

let sharedFontAtlasCanvas = null;
function getFontAtlasCanvas() {
    if (!sharedFontAtlasCanvas) {
        const c = document.createElement('canvas');
        c.width = c.height = 512;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 24px SFMono-Regular, Consolas, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 32; i < 127; i++) {
            ctx.fillText(String.fromCharCode(i), (i % 16) * 32 + 16, Math.floor(i / 16) * 32 + 18);
        }
        sharedFontAtlasCanvas = c;
    }
    return sharedFontAtlasCanvas;
}

export class LayoutRenderer {
    constructor(canvas, glOptions = {}) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2', {
            alpha: true,
            antialias: true,
            premultipliedAlpha: false,
            preserveDrawingBuffer: true,
            ...glOptions
        });
        if (!this.gl) {
            throw new Error("WebGL2 is not supported by this browser.");
        }
        this.glsl = window.SwissGL(this.gl);
        this.fontTex = this.glsl({}, { data: getFontAtlasCanvas(), size: [512, 512],
            format: 'rgba8', tag: 'font', filter:'miplinear'});
    }

    render(state) {
        const {
            width, height,
            dpr = window.devicePixelRatio || 1,
            panX = 0, panY = 0, zoom = 1.0,
            simTime = 0.0, simActive = false,
            clearColor = GRAPH_BG_COLOR,
            grid = null,
            id = '',
            nodesData, nodeCount = 0,
            linksData, linkCount = 0
        } = state;

        const physW = Math.round(width * dpr);
        const physH = Math.round(height * dpr);

        if (this.canvas.width < physW || this.canvas.height < physH) {
            this.canvas.width = Math.max(this.canvas.width || 0, physW);
            this.canvas.height = Math.max(this.canvas.height || 0, physH);
        }

        const view = [0, 0, physW, physH];
        const cx = width / 2;
        const cy = height / 2;
        const scale = 16.0 * zoom;

        const uniforms = {
            transform: [cx + panX, cy + panY, scale],
            viewSize: [width, height],
            u_simTime: simTime,
            u_simActive: simActive ? 1.0 : 0.0,
            u_maxDepth: state.maxDepth || 1.0,
            u_rotate: state.rotate ? 1.0 : 0.0,
            u_tStep: state.tStep !== undefined ? state.tStep : TIMING_CONFIG.defaultTStep,
            u_colorEdgesByDepth: state.colorEdgesByDepth !== undefined ? (state.colorEdgesByDepth ? 1.0 : 0.0) : 1.0,
            Blend: 's*sa+d*(1-sa)',
            Inc: `
                #define id2xy(id) ivec2((id) & 0xff, (id) >> 8)
                #define TIMING_PULSE_DURATION ${TIMING_CONFIG.pulseDuration}
                #define TIMING_FADE_DURATION ${TIMING_CONFIG.fadeDuration}
                vec2 applyRotate(vec2 p) {
                    return (u_rotate > 0.0) ? vec2(-p.y, p.x) : p;
                }
                vec2 worldToClip(vec2 p) {
                    vec2 s = p * transform.z + transform.xy;
                    return vec2((s.x / viewSize.x) * 2.0 - 1.0, 1.0 - (s.y / viewSize.y) * 2.0);
                }
                float getPulseProgress(float t, float tStart, float dur) {
                    return (t - tStart) / dur;
                }
                float mixInitialFade(float activeVal) {
                    if (u_simActive <= 0.0) return 1.0;
                    float initialFade = clamp(-u_simTime / TIMING_FADE_DURATION, 0.0, 1.0);
                    return mix(activeVal, 1.0, initialFade);
                }
            `
        };

        this.glsl({ Clear: clearColor, View: view });

        if (grid) {
            const { numVertLines, numHorizLines, fWeight, dirMask } = grid;
            const drawGridLines = {
                ...uniforms,
                fWeight: fWeight || 0.0,
                VP: `
                    vec2 viewMin = (vec2(0.0) - transform.xy) / transform.z;
                    vec2 viewMax = (viewSize - transform.xy) / transform.z;
                    
                    float logDist = log(80.0 / transform.z) / log(10.0);
                    float k = floor(logDist);
                    float step0 = pow(10.0, k);
                    float step1 = pow(10.0, k + 1.0);
                    
                    float startVal = floor(dot(viewMin, dirMask) / step0) * step0;
                    float val = startVal + float(ID.x) * step0;
                    
                    vec2 p0 = dirMask * val + (1.0 - dirMask) * viewMin;
                    vec2 p1 = dirMask * val + (1.0 - dirMask) * viewMax;
                    
                    float isAxis = (abs(val) < step0 * 0.001) ? 1.0 : 0.0;
                    float isMajor = (abs(round(val / step1) * step1 - val) < step0 * 0.001) ? 1.0 : 0.0;
                    
                    float width = mix(1.0, 2.0, isAxis);
                    float thickness = width / transform.z;
                    
                    vec2 worldPos = mix(p0, p1, UV.x) + dirMask * (XY.y * (thickness * 0.5));
                    VPos.xy = worldToClip(worldPos);
                    
                    varying float vAlpha = mix(mix(0.04 * (1.0 - fWeight), 0.04, isMajor), 0.1, isAxis);
                `,
                FP: `FOut = vec4(1.0, 1.0, 1.0, vAlpha);`
            };

            if (numVertLines > 0) {
                this.glsl({ ...drawGridLines, Grid: [numVertLines], dirMask: [1.0, 0.0], View: view });
            }
            if (numHorizLines > 0) {
                this.glsl({ ...drawGridLines, Grid: [numHorizLines], dirMask: [0.0, 1.0], View: view });
            }
        }

        if (linkCount > 0) {
            const h = (state.isDynamic === true) ? (MAX_GL_LINKS * 2) / 256 : Math.ceil((linkCount * 2) / 256);
            const linksTex = this.glsl({}, { data: linksData, size: [256, h], format: 'rgba32f', tag: id ? `links_${id}` : 'links' });
            this.glsl({
                ...uniforms,
                linksTex,
                Grid: [linkCount],
                View: view,
                VP: `
                    vec4 p01 = texelFetch(linksTex, id2xy(ID.x * 2), 0);
                    vec4 tData = texelFetch(linksTex, id2xy(ID.x * 2 + 1), 0);
                    
                    vec2 p0 = applyRotate(p01.xy);
                    vec2 p1 = applyRotate(p01.zw);
                    
                    vec2 dir = p1 - p0;
                    float dist = length(dir);
                    vec2 dp = (dist > 0.0) ? (dir / dist) : vec2(1.0, 0.0);
                    vec2 perp = vec2(-dp.y, dp.x);
                    
                    float thickness = max((1.0-UV.x)*0.1, 0.5/transform.z);
                    vec2 worldPos = mix(p0, p1, UV.x) + perp * (XY.y * thickness);
                    
                    VPos.xy = worldToClip(worldPos);
                    
                    float tDriver = tData.x * u_tStep;
                    float tTarget = tData.y * u_tStep;
                    float vProgress = getPulseProgress(u_simTime, tDriver, TIMING_PULSE_DURATION);
                    
                    float isHighlighted = tData.z;
                    float alpha = mix(0.2, 0.6, isHighlighted);
                    
                    float ratio = clamp(tData.x / max(u_maxDepth, 1.0), 0.0, 1.0);
                    vec3 depthColor = vec3(ratio, 0.898 * (1.0 - ratio), 1.0 - ratio * 0.667);
                    vec3 edgeColor = mix(vec3(1.0, 1.0, 1.0), depthColor, u_colorEdgesByDepth);
                    
                    varying vec4 vColor = vec4(edgeColor, alpha);
                    varying float vUVx = UV.x;
                    varying float vWaveCenter = clamp(vProgress, 0.0, 1.0);
                    varying float vActivePulse = step(0.0, vProgress) * step(vProgress, 1.1) * u_simActive;
                    varying float vActiveAfter = step(0.0, vProgress) * u_simActive;
                `,
                FP: `
                    float distToWave = abs(vUVx - vWaveCenter);
                    float wavePulse = smoothstep(0.15, 0.0, distToWave) * vActivePulse;
                    float isAfterPulse = smoothstep(vWaveCenter + 0.08, vWaveCenter - 0.02, vUVx) * vActiveAfter;
                    
                    float edgeBrightness = mixInitialFade(mix(0.5, 1.0, isAfterPulse));
                    float finalAlpha = mix(min(1.0, vColor.a * edgeBrightness), 1.0, wavePulse);
                    vec3 finalColor = mix(vColor.rgb * edgeBrightness, vec3(0.0, 0.8, 1.0), wavePulse);
                    FOut = vec4(finalColor, finalAlpha);
                `
            });
        }

        if (nodeCount > 0) {
            const h = (state.isDynamic === true) ? (MAX_GL_NODES * 3) / 256 : Math.ceil((nodeCount * 3) / 256);
            const nodesTex = this.glsl({}, { data: nodesData, size: [256, h], format: 'rgba32f', tag: id ? `nodes_${id}` : 'nodes' });
            this.glsl({
                ...uniforms,
                nodesTex,
                fontTex: this.fontTex,
                Grid: [nodeCount],
                View: view,
                VP: `
                    vec4 p0 = texelFetch(nodesTex, id2xy(ID.x * 3), 0);
                    vec4 col = texelFetch(nodesTex, id2xy(ID.x * 3 + 1), 0);
                    vec4 timeData = texelFetch(nodesTex, id2xy(ID.x * 3 + 2), 0);
                    
                    vec2 center = applyRotate(p0.xy);
                    float radius = p0.z;
                    float charCode = timeData.y;
                    float tActivate = timeData.x * u_tStep;
                    float prog = clamp(getPulseProgress(u_simTime, tActivate, TIMING_PULSE_DURATION), 0.0, 1.0);
                    float brightness = (u_simActive > 0.0) ? mixInitialFade(mix(0.5, 1.0, prog)) : (timeData.z > 0.0 ? timeData.z : 1.0);
                    
                    vec2 worldPos = center + XY * radius * 2.0;
                    VPos.xy = worldToClip(worldPos);
                    
                    float screenRadius = radius * transform.z;
                    float hasGlyph = (charCode > 0.0 && screenRadius >= 4.0) ? 1.0 : 0.0;
                    int charId = int(charCode + 0.5);
                    vec2 atlasBase = vec2(charId % 16, charId / 16) / 16.0;
                    
                    varying vec4 vColor = vec4(col.rgb * brightness, p0.w);
                    varying vec2 vXY = XY * 2.0;
                    varying float vBrightness = brightness;
                    varying float vHasGlyph = hasGlyph;
                    varying vec2 vAtlasBase = atlasBase;
                `,
                FP: `
                    float r = length(vXY);
                    float alpha = smoothstep(1.0, 0.85, r);
                    
                    vec3 finalColor = vColor.rgb;
                    if (vHasGlyph > 0.0) {
                        vec2 uv = (vXY + vec2(1.0)) * 0.5;
                        if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
                            float glyphAlpha = texture(fontTex, vAtlasBase + uv / 16.0).a;
                            finalColor = mix(finalColor, vec3(1.0) * vBrightness, glyphAlpha * 0.9);
                        }
                    }
                    FOut = vec4(finalColor, vColor.a * alpha);
                `
            });
        }
    }
}

export function writeNodeSlot(buffer, index, x, y, r, opacity, rgb, delay, charCode, brightness) {
    const offset = index * 12;
    buffer[offset] = x;
    buffer[offset + 1] = y;
    buffer[offset + 2] = r;
    buffer[offset + 3] = opacity;
    buffer[offset + 4] = rgb[0];
    buffer[offset + 5] = rgb[1];
    buffer[offset + 6] = rgb[2];
    buffer[offset + 7] = 0.0;
    buffer[offset + 8] = delay;
    buffer[offset + 9] = charCode;
    buffer[offset + 10] = brightness;
    buffer[offset + 11] = 0.0;
}

export function writeLinkSlot(buffer, index, p0x, p0y, p1x, p1y, tDriver, tTarget, isHighlighted) {
    const offset = index * 8;
    buffer[offset] = p0x;
    buffer[offset + 1] = p0y;
    buffer[offset + 2] = p1x;
    buffer[offset + 3] = p1y;
    buffer[offset + 4] = tDriver;
    buffer[offset + 5] = tTarget;
    buffer[offset + 6] = isHighlighted;
    buffer[offset + 7] = 0.0;
}

export function packNodes(graph, layoutNodeR, smoothedX, smoothedY, activeCellId, activeDescendants, outBuffer) {
    let count = 0;
    const active = graph.cell.active;
    for (let i = 0; i < graph.cell.count; i++) {
        if (active[i] === 0) continue;
        if (count >= MAX_GL_NODES) break;

        const name = graph.cell.name[i];
        let pr = layoutNodeR[i] || 0.5;
        if (name === 'BUF') pr *= 0.5;

        const isExpandable = graph.isExpandable(i);
        const isDimmed = activeCellId !== null && !activeDescendants.has(i);

        let rgb = [0.216, 0.698, 0.302]; // default primitive green
        let charCode = 0.0;
        if (graph.cell.type[i] === CELL_TYPES.INPUT) {
            rgb = [0.2, 0.604, 0.941];
            charCode = 73; // 'I'
        } else if (graph.cell.type[i] === CELL_TYPES.OUTPUT) {
            rgb = [1.0, 0.42, 0.42];
            charCode = 79; // 'O'
        } else if (isExpandable) {
            rgb = CELL_STYLES['__EXPANDABLE__'].rgb;
        } else {
            const style = CELL_STYLES[name];
            if (style) {
                rgb = style.rgb;
                if (style.label) charCode = style.label.charCodeAt(0);
            }
        }

        const opacity = isDimmed ? 0.15 : 1.0;
        const brightness = isDimmed ? 0.35 : 1.0;
        writeNodeSlot(outBuffer, count, smoothedX[i], smoothedY[i], pr, opacity, rgb, graph.cell.lastTime[i] || 0.0, charCode, brightness);
        count++;
    }
    return count;
}

export function packLinks(graph, smoothedX, smoothedY, activeCellId, activeDescendants, outBuffer) {
    let count = 0;
    const active = graph.cell.active;
    for (let netIdx = 0; netIdx < graph.net.count; netIdx++) {
        const driver = graph.net.driverCell[netIdx];
        if (driver === -1 || active[driver] === 0) continue;

        const driverX = smoothedX[driver];
        const driverY = smoothedY[driver];
        const isHighlighted = activeCellId === null || activeDescendants.has(driver) ? 1.0 : 0.0;

        const localIdx = netIdx - graph.cell.netStart[driver];
        const dx = localIdx < netOffsetsX.length ? netOffsetsX[localIdx] : 0;
        const dy = localIdx < netOffsetsX.length ? netOffsetsY[localIdx] : 0;

        const tDriver = graph.cell.lastTime[driver] || 0.0;
        const pins = graph.getNetPins(netIdx);

        for (const pinIdx of pins) {
            const terminal = graph.pin.cell[pinIdx];
            if (terminal === -1 || active[terminal] === 0 || terminal === driver) continue;
            if (count >= MAX_GL_LINKS) break;

            const tTarget = graph.cell.lastTime[terminal] || (tDriver + 1.0);
            writeLinkSlot(outBuffer, count, driverX + dx, driverY + dy, smoothedX[terminal] + dx, smoothedY[terminal] + dy, tDriver, tTarget, isHighlighted);
            count++;
        }
    }
    return count;
}

export function createLegendOverlay(container, data, colorByDepth, hideLegend) {
    let legend = container.querySelector('.canvas-legend');
    if (!data || colorByDepth || hideLegend) {
        if (legend) legend.remove();
        return;
    }

    const usedLabels = new Set();
    if (data.unique_labels && data.labels) {
        for (let i = 0; i < data.labels.length; i++) {
            const l = data.unique_labels[data.labels[i]];
            if (l) usedLabels.add(l);
        }
    } else if (data.cell && data.cell.name) {
        for (let i = 0; i < data.cell.count; i++) {
            if (data.cell.active && data.cell.active[i] === 0) continue;
            if (data.isExpandable && data.isExpandable(i)) {
                usedLabels.add('__EXPANDABLE__');
            } else if (data.cell.type[i] === CELL_TYPES.INPUT) {
                usedLabels.add('__INPUTS__');
            } else if (data.cell.type[i] === CELL_TYPES.OUTPUT) {
                usedLabels.add('__OUTPUTS__');
            } else {
                usedLabels.add(data.cell.name[i]);
            }
        }
    }

    const items = [];
    let hasInput = false, hasOutput = false;
    usedLabels.forEach(l => {
        if (l.startsWith('in:') || l === '__INPUTS__') hasInput = true;
        else if (l.startsWith('out:') || l === '__OUTPUTS__') hasOutput = true;
    });

    if (hasInput || usedLabels.size > 0) {
        items.push(CELL_STYLES['__INPUTS__']);
    }
    if (hasOutput || usedLabels.size > 0) {
        items.push(CELL_STYLES['__OUTPUTS__']);
    }
    if (usedLabels.has('__EXPANDABLE__')) {
        items.push(CELL_STYLES['__EXPANDABLE__']);
    }

    const addedNames = new Set(['Input', 'Output', 'Composite']);
    usedLabels.forEach(l => {
        if (l.startsWith('in:') || l.startsWith('out:') || l === '__INPUTS__' || l === '__OUTPUTS__' || l === '__EXPANDABLE__') return;
        const style = CELL_STYLES[l];
        if (style && style.name && !addedNames.has(style.name)) {
            items.push(style);
            addedNames.add(style.name);
        }
    });

    if (items.length === 0) {
        if (legend) legend.remove();
        return;
    }

    const newHtml = items.map(item => {
        const rgbStr = `rgb(${Math.round(item.rgb[0]*255)}, ${Math.round(item.rgb[1]*255)}, ${Math.round(item.rgb[2]*255)})`;
        const size = item.scale ? `${Math.max(4, Math.round(8 * item.scale))}px` : '8px';
        return `<span class="legend-item"><span style="width: 8px; display: inline-flex; justify-content: center; align-items: center;"><span class="legend-dot" style="background: ${rgbStr}; width: ${size}; height: ${size};"></span></span>${item.name}</span>`;
    }).join('');

    if (!legend || legend.getAttribute('data-type') !== 'gate' || legend.innerHTML !== newHtml) {
        if (legend) legend.remove();
        legend = document.createElement('div');
        legend.className = 'canvas-legend';
        legend.setAttribute('data-type', 'gate');
        legend.innerHTML = newHtml;
        container.appendChild(legend);
    }
}

