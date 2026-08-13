# MorphoHDL

**A minimalistic language for growing circuits and biological nanostructures through structural recursion.**

MorphoHDL is an experimental Hardware Description Language (HDL), graph rewrite system, and DNA nanostructure planner built around recursive division and rewiring of cell definitions. Inspired by Parametric L-Systems and functional HDLs, MorphoHDL grows physical geometry, logical circuit structures, and DNA nanostructures concurrently.

---

## 🌟 Key Features

* **Dual-Domain Execution**: Supports both recursive digital circuit synthesis and recursive DNA origami / structural nanotechnology design.
* **Recursive & Size-Agnostic**: Cells define rewrite rules where nodes are dynamically replaced by subcells or nucleotides. Bus widths/backbones are inferred and split automatically at runtime.
* **High-Performance SoA Engine**: The core compiler utilizes a Struct-of-Arrays (SoA) flat memory layout for maximum cache locality, high speed, and minimal GC overhead.
* **Lightweight DNA Validation & Assembly Planner**: Features real-time, non-topological verification of strand complementarity, antiparallel polarity, sequence continuity, steric clash heuristics, and thermal annealing assembly planning.
* **Interactive WebGL Explorer**: Integrated real-time viewer (`demo.html`) supporting classic circuit timing waves, DNA topological grids, 3D double helices, and separated assembly exploded views.

---

## 🚀 Getting Started

MorphoHDL runs natively in the browser with no build steps required.

### 1. Launching Locally
Start any local HTTP server from the repository root:
```bash
python3 -m http.server 8000
```

### 2. Interactive Environments
* **Interactive Explorer (`demo.html`)**: Open `http://localhost:8000/demo.html` to experiment with live circuit growth, parameter controls, and layout visualization.
* **Interactive Article (`index.html`)**: Open `http://localhost:8000/index.html` to read the interactive documentation and walk through classical boolean circuit examples.

---

## 💻 Example Usage

MorphoHDL uses a clean, dataflow-style Python syntax where bus sizes are inferred dynamically:

```python
# Define building blocks using Lookup Tables (LUTs)
Xor3 = LUT(3, 0b1001_0110)
Maj3 = LUT(3, 0b1110_1000)

# Base case (1-bit full adder)
@morpho
def full_adder(a, b, c_in):   
    sum = Xor3(a, b, c_in)
    c_out = Maj3(a, b, c_in)
    return sum, c_out

# Recursive N-bit ripple adder with 1-bit fallback
@morpho(fallback=full_adder)
def ripple_adder(a, b, c):
    a0, a1 = SPLIT(a)
    b0, b1 = SPLIT(b)
    s0, c_mid = ripple_adder(a0, b0, c)
    s1, c_out = ripple_adder(a1, b1, c_mid)
    sum = CAT(s0, s1)
    return sum, c_out
```

---

## 📁 Repository Structure

* `tiny_morpho.py`: Standalone Python reference implementation of MorphoHDL with simulation, compilation, and verification tests.
* `demo.html` / `index.html`: Web-based interactive explorer and interactive article.
* `js/`: Core browser runtime and engine:
  * `compiler.js`: Flat SoA compiler and width inference engine.
  * `viewer.js` & `layout_renderer.js`: Interactive WebGL/Canvas circuit visualizer.
  * `force_layout.js` & `hex_layout.js`: Physics and grid-based circuit layout engines.
* `graphs_engine/`: High-performance C/WASM graph layout backend.
* `scratch/`: Experimental scripts, layout benchmarks, and verification tools.

---

## 📜 License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.

---

## Disclaimer

This is not an officially supported Google product. This project is not
eligible for the [Google Open Source Software Vulnerability Rewards
Program](https://bughunters.google.com/open-source-security).
