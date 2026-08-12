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

import { MorphoViewer } from './viewer.js';
import { loadMorphoCode, loadScript } from './utils.js';
import { parse } from './parser.js';
import { compileModule } from './compiler.js';
import { HERO_DESIGNS } from './presets.js';

const seen = new Set();
const rootSignature = [];
HERO_DESIGNS.forEach(item => {
    const signatureStr = JSON.stringify(item.design);
    if (!seen.has(signatureStr)) {
        seen.add(signatureStr);
        rootSignature.push(item.design);
    }
});

let viewer = null;
let code = "";
let cellDomElements = [];
let previousActive = new Uint8Array(0);

const selectMethod = document.getElementById('select-method');
const selectVisibility = document.getElementById('select-visibility');
const btnAutoExpand = document.getElementById('btn-auto-expand');
const rangeSpeed = document.getElementById('range-speed');
const valSpeed = document.getElementById('val-speed');
const stats = document.getElementById('stats');

const codeEditor = document.getElementById('code-editor');
const inputDesignPreset = document.getElementById('input-design-preset');
const selectDesignPreset = document.getElementById('select-design-preset');
const btnCompile = document.getElementById('btn-compile');

function initDesignPresets() {
    if (!selectDesignPreset) return;
    selectDesignPreset.innerHTML = "";
    const promptOpt = document.createElement('option');
    promptOpt.value = "";
    promptOpt.disabled = true;
    promptOpt.selected = true;
    promptOpt.textContent = "Presets...";
    selectDesignPreset.appendChild(promptOpt);

    rootSignature.forEach(([name, args]) => {
        const presetStr = `${name}(${args.join(', ')})`;
        const opt = document.createElement('option');
        opt.value = presetStr;
        opt.textContent = presetStr;
        selectDesignPreset.appendChild(opt);
    });
}

initDesignPresets();

// Editor Syntax Highlighting Overlay Elements
const highlightBackdrop = document.getElementById('code-highlight-backdrop');
const highlightContent = document.getElementById('code-highlight-content');
let prismLoaded = false;

function updateHighlighting() {
    let text = codeEditor.value;
    if (text[text.length - 1] === '\n') {
        text += ' '; // prevent line jump at trailing newline
    }
    highlightContent.textContent = text;
    if (prismLoaded && window.Prism) {
        window.Prism.highlightElement(highlightContent);
    }
}

// Synchronize scrolls
codeEditor.addEventListener('scroll', () => {
    highlightBackdrop.scrollTop = codeEditor.scrollTop;
    highlightBackdrop.scrollLeft = codeEditor.scrollLeft;
});

// Load syntax highlighter asynchronously
loadScript('third_party/prism/prism-core.min.js')
    .then(() => loadScript('third_party/prism/prism-python.min.js'))
    .then(() => {
        prismLoaded = true;
        updateHighlighting();
    })
    .catch(err => console.error("Failed to load syntax highlighter:", err));

// Single source of truth for initial parameters
const INITIAL_SPEED = 50;
const INITIAL_VISIBILITY = 'both';
const INITIAL_METHOD = 'bfs';

let autoExpandSpeed = INITIAL_SPEED;
let visibility = INITIAL_VISIBILITY;
let method = INITIAL_METHOD;

rangeSpeed.value = autoExpandSpeed;
valSpeed.textContent = `${autoExpandSpeed}%/s`;
selectVisibility.value = visibility;
selectMethod.value = method;

// Parse query parameters
const urlParams = new URLSearchParams(window.location.search);
const paramDesign = urlParams.get('design');
const paramMethod = urlParams.get('method');

if (paramMethod) {
    method = paramMethod;
    selectMethod.value = paramMethod;
}

function initViewer(name, inputs) {
    // Clear sidebar tree DOM
    document.getElementById("cell-tree").innerHTML = "";
    cellDomElements = [];
    previousActive = new Uint8Array(0);
    document.getElementById('btn-simulate').textContent = "Run Simulation";
    btnAutoExpand.textContent = "Play Auto-Expand";

    if (!viewer) {
        viewer = new MorphoViewer({
            container: document.getElementById('canvas-container'),
            design: name,
            inputs: inputs,
            visibility: visibility,
            autoExpandSpeed: autoExpandSpeed,
            method: method,
            interactive: true,
            autoscale: true,
            onCellAdded: (cellIdx, cellName, parentIdx) => {
                addTreeDOMNode(cellIdx, cellName, parentIdx);
            },
            onActiveCellChanged: (cellIdx) => {
                updateTreeDOMSelection(cellIdx);
            },
            onGrowthComplete: () => {
                btnAutoExpand.textContent = "Play Auto-Expand";
                viewer.startSimulation(); // Auto-start timing wave simulation!
                document.getElementById('btn-simulate').textContent = "Stop Simulation";
            }
        });
        viewer.init(code);
        updateStatsLoop();
    } else {
        viewer.code = code;
        viewer.setDesign(name, inputs);
    }
    
    // Auto-start growth on compilation
    viewer.startAutoExpand(autoExpandSpeed);
    btnAutoExpand.textContent = "Pause Auto-Expand";
}

function addTreeDOMNode(i, name, parentIdx) {
    const container = document.getElementById("cell-tree");
    
    const div = document.createElement("div");
    div.className = "tree-node";
    
    const toggle = document.createElement("span");
    toggle.className = "tree-toggle";
    toggle.textContent = "•"; 
    
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = name;
    
    const childContainer = document.createElement("div");
    childContainer.style.display = "none"; 
    
    toggle.onclick = (e) => {
        e.stopPropagation();
        const isCollapsed = childContainer.style.display === "none";
        childContainer.style.display = isCollapsed ? "block" : "none";
        toggle.textContent = isCollapsed ? "▼" : "▶";
    };

    label.onclick = (e) => {
        e.stopPropagation();
        const nextActive = (viewer.activeCellId === i) ? null : i;
        viewer.setActiveCell(nextActive);
    };
    
    div.appendChild(toggle);
    div.appendChild(label);
    div.appendChild(childContainer);
    
    cellDomElements[i] = { div, label, toggle, childContainer };
    
    if (parentIdx === -1) {
        container.appendChild(div);
    } else {
        const parentDom = cellDomElements[parentIdx];
        if (parentDom) {
            parentDom.childContainer.appendChild(div);
            if (parentDom.toggle.textContent === "•") {
                parentDom.toggle.textContent = "▶";
            }
        } else {
            container.appendChild(div);
        }
    }
}

function updateTreeDOMSelection(activeId) {
    for (let i = 0; i < cellDomElements.length; i++) {
        const dom = cellDomElements[i];
        if (dom) {
            dom.label.classList.toggle("active", activeId === i);
        }
    }
}

function updateStatsLoop() {
    if (!viewer || !viewer.graph) return;
    
    let activeCells = 0;
    let activeNets = 0;
    const active = viewer.graph.cell.active;
    const netStart = viewer.graph.cell.netStart;
    const outputCount = viewer.graph.cell.outputCount;
    const fanout = viewer.graph.net.fanout;

    for (let i = 0; i < viewer.graph.cell.count; i++) {
        if (active[i] === 1) {
            activeCells++;
            const nStart = netStart[i];
            if (nStart !== -1) {
                for (let j = 0; j < outputCount[i]; j++) {
                    if (fanout[nStart + j] > 0) activeNets++;
                }
            }
        }
    }

    stats.textContent = `Cells: ${activeCells} | Nets: ${activeNets}`;
    
    // Sync expanded state highlights
    if (viewer.graph.cell.capacity > previousActive.length) {
        const newPrev = new Uint8Array(viewer.graph.cell.capacity);
        newPrev.set(previousActive);
        previousActive = newPrev;
    }
    for (let i = 0; i < viewer.graph.cell.count; i++) {
        const isActive = viewer.graph.cell.active[i];
        if (isActive !== previousActive[i]) {
            const dom = cellDomElements[i];
            if (dom) {
                dom.label.classList.toggle("expanded", isActive === 0);
            }
            previousActive[i] = isActive;
        }
    }

    // Update Assembly Planner Report
    const reportEl = document.getElementById('assembly-planner-report');
    if (reportEl && viewer.dnaReport && viewer.dnaReport.baseCount > 0) {
        const report = viewer.dnaReport;
        let html = `<strong>=== ASSEMBLY PLAN & REPORT ===</strong><br>`;
        html += `Bases: ${report.baseCount} | Strands: ${report.strandsCount} | Pairs: ${report.pairsCount}<br>`;
        html += `Validation Score: <span style="color: ${report.totalPenalty === 0 ? '#48bb78' : '#f56565'}">${(100 - report.totalPenalty * 10).toFixed(1)}%</span><br>`;
        html += `Complexity Score: ${report.assemblyComplexity.toFixed(1)}<br><br>`;

        if (report.penalties.length > 0) {
            html += `<span style="color: #f56565"><strong>Warnings/Errors (${report.penalties.length}):</strong></span><br>`;
            report.penalties.slice(0, 5).forEach(p => {
                html += `- ${p}<br>`;
            });
            if (report.penalties.length > 5) html += `- ...and ${report.penalties.length - 5} more<br>`;
            html += `<br>`;
        } else {
            html += `<span style="color: #48bb78"><strong>✓ Validation PASS: 100% Perfect Design!</strong></span><br><br>`;
        }

        html += `<strong>Strand Decomposition & Sequences:</strong><br>`;
        report.strands.forEach((strand, id) => {
            const seq = strand.map(idx => viewer.graph.cell.name[idx]).join('');
            const role = id === 0 ? 'Scaffold' : 'Staple';
            html += `Strand #${id} (${role}, ${strand.length}nt):<br>`;
            html += `<span style="color: #63b3ed; word-break: break-all;">5'-${seq}-3'</span><br>`;
        });

        html += `<br><strong>Scaffold/Staple Routing:</strong><br>`;
        if (report.strandsCount > 1) {
            report.strands.forEach((strand, id) => {
                if (id > 0) {
                    const pairings = [];
                    strand.forEach((idx, pos) => {
                        const partner = report.pairs[idx];
                        if (partner !== -1) {
                            pairings.push(`${pos}➔Scaf:${viewer.graph.cell.dnaStrandId[partner] || 0}`);
                        }
                    });
                    if (pairings.length > 0) {
                        html += `Staple #${id} pairing routes:<br>${pairings.join(', ')}<br>`;
                    }
                }
            });
        } else {
            html += `No staple strands present to route.<br>`;
        }

        html += `<br><strong>Ordered Assembly Steps:</strong><br>`;
        html += `1. Aliquot Strands to final concentrations (10 nM Scaffold, 100 nM each Staple).<br>`;
        html += `2. Buffer with 1x TAE containing 12.5 mM Mg2+.<br>`;
        html += `3. Thermal anneal: Heat to 90°C for 2 min, cool to 20°C at -1.0°C/min.<br>`;
        html += `4. Purify via 1% agarose gel extraction or spin-filter filtration.<br>`;

        reportEl.innerHTML = html;
    } else if (reportEl) {
        reportEl.innerHTML = `No DNA structure loaded. Select a DNA preset to begin planning.`;
    }
    
    setTimeout(updateStatsLoop, 500);
}

function resetViewer() {
    if (!viewer) return;
    document.getElementById("cell-tree").innerHTML = "";
    cellDomElements = [];
    previousActive = new Uint8Array(0);
    viewer.reset();
    btnAutoExpand.textContent = "Play Auto-Expand";
    document.getElementById('btn-simulate').textContent = "Run Simulation";
}

// UI Event Listeners
document.getElementById('btn-expand').onclick = () => {
    if (viewer) {
        viewer.stepExpand();
    }
};

btnAutoExpand.onclick = () => {
    if (!viewer) return;
    if (viewer.isAutoExpanding) {
        viewer.stopAutoExpand();
        btnAutoExpand.textContent = "Play Auto-Expand";
    } else {
        if (viewer.isFullyExpanded()) {
            resetViewer();
        }
        viewer.startAutoExpand(autoExpandSpeed);
        btnAutoExpand.textContent = "Pause Auto-Expand";
    }
};

document.getElementById('btn-toggle').onclick = () => {
    if (viewer) {
        viewer.isRunning = !viewer.isRunning;
        document.getElementById('btn-toggle').textContent = viewer.isRunning ? "Pause Layout" : "Resume Layout";
    }
};

document.getElementById('btn-reset').onclick = () => {
    resetViewer();
};


function downloadJSON(suffix, content) {
    if (!viewer || !content) return;
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${viewer.designName}_${viewer.designInputs.join('x')}_${suffix}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

document.getElementById('btn-export-json').onclick = () => {
    if (viewer) downloadJSON('layout', viewer.exportJSON());
};

document.getElementById('btn-export-mask').onclick = () => {
    if (viewer) downloadJSON('mask', viewer.exportMask());
};

document.getElementById('btn-simulate').onclick = () => {
    if (!viewer) return;
    if (viewer.simActive) {
        viewer.stopSimulation();
        document.getElementById('btn-simulate').textContent = "Run Simulation";
    } else {
        viewer.startSimulation();
        document.getElementById('btn-simulate').textContent = "Stop Simulation";
    }
};

function showCompileError(msg) {
    const errorDiv = document.getElementById('compile-error');
    if (msg) {
        errorDiv.textContent = msg;
        errorDiv.style.display = 'block';
    } else {
        errorDiv.style.display = 'none';
        errorDiv.textContent = '';
    }
}



function highlightErrorLine(lineNum) {
    const text = codeEditor.value;
    const lines = text.split('\n');
    
    if (lineNum > 0 && lineNum <= lines.length) {
        let startIdx = 0;
        for (let i = 0; i < lineNum - 1; i++) {
            startIdx += lines[i].length + 1; // +1 for \n
        }
        const endIdx = startIdx + lines[lineNum - 1].length;
        
        codeEditor.focus();
        codeEditor.setSelectionRange(startIdx, endIdx);
        
        const lineHeight = 16.5;
        codeEditor.scrollTop = Math.max(0, (lineNum - 5) * lineHeight);
        highlightBackdrop.scrollTop = codeEditor.scrollTop;
        highlightBackdrop.scrollLeft = codeEditor.scrollLeft;
    }
}

function highlightPresetInEditor(presetStr) {
    if (!presetStr || !codeEditor) return;
    const match = presetStr.trim().match(/^([a-zA-Z_]\w*)/);
    if (!match) return;
    const funcName = match[1];
    const text = codeEditor.value;
    const lines = text.split('\n');
    let lineNum = -1;
    const regex = new RegExp(`^\\s*def\\s+${funcName}\\s*\\(`);
    for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
            lineNum = i + 1;
            break;
        }
    }
    if (lineNum > 0) {
        let startLine = lineNum;
        if (lineNum > 1 && lines[lineNum - 2].trim() === '@morpho') {
            startLine = lineNum - 1;
        }
        let startIdx = 0;
        for (let i = 0; i < startLine - 1; i++) {
            startIdx += lines[i].length + 1;
        }
        let endIdx = startIdx;
        for (let i = startLine - 1; i < lineNum; i++) {
            endIdx += lines[i].length + (i < lineNum - 1 ? 1 : 0);
        }
        codeEditor.focus();
        codeEditor.setSelectionRange(startIdx, endIdx);
        const lineHeight = 16.5;
        codeEditor.scrollTop = Math.max(0, (startLine - 5) * lineHeight);
        highlightBackdrop.scrollTop = codeEditor.scrollTop;
        highlightBackdrop.scrollLeft = codeEditor.scrollLeft;
    }
}

function compileAndRun() {
    const editorCode = codeEditor.value;
    const inputVal = inputDesignPreset.value.trim();
    
    if (!inputVal) {
        showCompileError("Error: No design target selected.");
        return;
    }

    const match = inputVal.match(/^([a-zA-Z_]\w*)\s*\(([^)]*)\)$/);
    if (!match) {
        showCompileError("Error: Invalid design format. Must be like 'root_name(inputs...)'");
        return;
    }

    const rootName = match[1];
    const sigText = match[2];
    
    let signature = [];
    if (sigText.trim().length > 0) {
        try {
            signature = sigText.split(',').map(s => {
                const val = parseInt(s.trim(), 10);
                if (isNaN(val)) throw new Error("Invalid integer: " + s);
                return val;
            });
        } catch (err) {
            showCompileError("Signature parsing error: " + err.message);
            return;
        }
    }
    
    try {
        const ast = parse(editorCode);
        const isDNA = ['duplex', 'hairpin', 'junction_4arm', 'helix_bundle', 'scaffold_staple_tile'].includes(rootName);
        compileModule(ast, rootName, signature, !isDNA, isDNA ? null : 4);
        
        showCompileError(null);
        code = editorCode;
        initViewer(rootName, signature);
    } catch (err) {
        console.error("Compilation failed:", err);
        showCompileError(err.message || err.toString());
        if (err.line !== undefined) {
            highlightErrorLine(err.line);
        }
    }
}

// Editor TAB indentation helper
codeEditor.onkeydown = (e) => {
    if (e.key === 'Tab') {
        e.preventDefault();
        const start = codeEditor.selectionStart;
        const end = codeEditor.selectionEnd;
        codeEditor.value = codeEditor.value.substring(0, start) + "    " + codeEditor.value.substring(end);
        codeEditor.selectionStart = codeEditor.selectionEnd = start + 4;
        updateHighlighting();
    }
};

codeEditor.oninput = () => {
    updateHighlighting();
};
selectDesignPreset.onchange = () => {
    if (selectDesignPreset.value) {
        inputDesignPreset.value = selectDesignPreset.value;
        compileAndRun();
        highlightPresetInEditor(selectDesignPreset.value);
    }
};


btnCompile.onclick = () => {
    compileAndRun();
};

selectMethod.onchange = () => {
    method = selectMethod.value;
    if (viewer) {
        viewer.method = method;
    }
};

selectVisibility.onchange = () => {
    visibility = selectVisibility.value;
    if (viewer) {
        viewer.visibility = visibility;
    }
};

const selectDnaMode = document.getElementById('select-dna-mode');
if (selectDnaMode) {
    selectDnaMode.onchange = () => {
        if (viewer) {
            viewer.dnaMode = selectDnaMode.value;
            viewer.needsTextureUpdate = true;
        }
    };
}

rangeSpeed.oninput = () => {
    autoExpandSpeed = parseInt(rangeSpeed.value, 10);
    valSpeed.textContent = `${autoExpandSpeed}%/s`;
    if (viewer && viewer.isAutoExpanding) {
        viewer.autoExpandSpeed = autoExpandSpeed;
    }
};

// Initial Load
loadMorphoCode('.').then(src => {
    codeEditor.value = src;
    updateHighlighting();
    
    // Choose initial design preset
    let initialPresetStr = "";
    if (paramDesign) {
        const preset = rootSignature.find(([name]) => name === paramDesign);
        if (preset) {
            initialPresetStr = `${paramDesign}(${preset[1].join(', ')})`;
        } else {
            initialPresetStr = `${paramDesign}(16)`;
        }
    } else {
        const firstOpt = selectDesignPreset.children[1];
        if (firstOpt) {
            initialPresetStr = firstOpt.value;
        } else {
            initialPresetStr = "ripple_adder(32, 32, 1)";
        }
    }
    inputDesignPreset.value = initialPresetStr;
    
    compileAndRun();
    highlightPresetInEditor(initialPresetStr);
}).catch(err => {
    console.error("Failed to load Morpho code:", err);
    showCompileError("Initial load failed: " + err.message);
});

// Drag-resizer helper: handle element + cursor style + per-move apply callback
function makeResizer(handle, cursor, apply) {
    let resizing = false;
    handle.onmousedown = () => {
        resizing = true;
        handle.classList.add('active');
        document.body.style.cursor = cursor;
        document.body.style.userSelect = 'none';
    };
    window.addEventListener('mousemove', (e) => {
        if (resizing) apply(e);
    });
    window.addEventListener('mouseup', () => {
        if (!resizing) return;
        resizing = false;
        handle.classList.remove('active');
        document.body.style.cursor = 'default';
        document.body.style.userSelect = 'auto';
    });
}

const sidebar = document.getElementById('sidebar');
makeResizer(document.getElementById('sidebar-resizer'), 'col-resize', (e) => {
    const newWidth = e.clientX;
    if (newWidth > 200 && newWidth < 800) sidebar.style.width = `${newWidth}px`;
});

const treeSection = document.getElementById('tree-section');
makeResizer(document.getElementById('tree-resizer'), 'row-resize', (e) => {
    const newHeight = treeSection.getBoundingClientRect().bottom - e.clientY;
    if (newHeight > 60 && newHeight < 600) treeSection.style.maxHeight = `${newHeight}px`;
});
