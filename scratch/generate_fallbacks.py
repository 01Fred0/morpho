# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import json
import os
import math

CELL_STYLES = {
    '__INPUTS__': [0.2, 0.604, 0.941],
    '__OUTPUTS__': [1.0, 0.42, 0.42],
    '__EXPANDABLE__': [0.98, 0.69, 0.02],
    'And': [0.318, 0.812, 0.4],
    'Or': [0.988, 0.769, 0.098],
    'Xor': [0.8, 0.365, 0.91],
    'Xor3': [0.518, 0.369, 0.969],
    'Maj3': [1.0, 0.573, 0.169],
    'carry_op': [0.133, 0.722, 0.812],
    'BUF': [0.55, 0.6, 0.68],
    'Mux2': [0.15, 0.75, 0.45],
    'Not': [0.95, 0.25, 0.55]
}

def hex_to_rgb(hex_str):
    h = hex_str.lstrip('#')
    if len(h) == 3:
        h = ''.join(c*2 for c in h)
    num = int(h, 16)
    return [((num >> 16) & 255) / 255.0, ((num >> 8) & 255) / 255.0, (num & 255) / 255.0]

def rgb_to_hex(rgb):
    r = max(0, min(255, int(rgb[0] * 255)))
    g = max(0, min(255, int(rgb[1] * 255)))
    b = max(0, min(255, int(rgb[2] * 255)))
    return f"#{r:02x}{g:02x}{b:02x}"

def compute_depth(x, labels, unique_labels, edges):
    n = len(x)
    adj = [[] for _ in range(n)]
    in_deg = [0] * n
    for i in range(0, len(edges), 2):
        u, v = edges[i], edges[i+1]
        adj[u].append(v)
        in_deg[v] += 1
    
    depth = [-1] * n
    queue = []
    for i in range(n):
        l = unique_labels[labels[i]]
        if l.startswith('in:') or in_deg[i] == 0:
            queue.append(i)
            depth[i] = 0
            
    max_depth = 0
    head = 0
    while head < len(queue):
        u = queue[head]
        head += 1
        cur = depth[u]
        for v in adj[u]:
            if depth[v] < cur + 1:
                depth[v] = cur + 1
                max_depth = max(max_depth, depth[v])
                queue.append(v)
    return depth, max_depth

def generate_svg(layout_file, output_file, node_size=0.5, color_by_depth=False, mask_files=None, mask_colors=None):
    if not os.path.exists(layout_file):
        print(f"Skipping missing file: {layout_file}")
        return
        
    with open(layout_file, 'r') as f:
        data = json.load(f)
    x = data.get('x', [])
    y = data.get('y', [])
    labels = data.get('labels', [])
    unique_labels = data.get('unique_labels', [])
    edges = data.get('edges', [])
    n = len(x)
    if n == 0:
        return
        
    depth, max_depth = compute_depth(x, labels, unique_labels, edges)
    
    node_mask_colors = [None] * n
    if mask_files and mask_colors:
        for m_file, m_col in zip(mask_files, mask_colors):
            if os.path.exists(m_file):
                with open(m_file, 'r') as mf:
                    indices = json.load(mf)
                rgb = hex_to_rgb(m_col)
                for idx in indices:
                    if 0 <= idx < n:
                        node_mask_colors[idx] = rgb
                        
    x_min, x_max = min(x), max(x)
    y_min, y_max = min(y), max(y)
    dx = x_max - x_min
    dy = y_max - y_min
    
    rotate = dy > dx * 1.2
    if rotate:
        x, y = [-val for val in y], x
        x_min, x_max = min(x), max(x)
        y_min, y_max = min(y), max(y)
        dx = x_max - x_min
        dy = y_max - y_min
        
    padding = max(dx, dy) * 0.08 + (node_size * 2)
    vb_x = x_min - padding
    vb_y = y_min - padding
    vb_w = dx + 2 * padding
    vb_h = dy + 2 * padding
    
    lines = []
    lines.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb_x:.1f} {vb_y:.1f} {vb_w:.1f} {vb_h:.1f}" width="100%" height="100%">')
    lines.append(f'  <rect x="{vb_x:.1f}" y="{vb_y:.1f}" width="{vb_w:.1f}" height="{vb_h:.1f}" fill="#0f172a" rx="{vb_w*0.015:.1f}" />')
    
    stroke_w = max(vb_w, vb_h) * 0.0022
    
    # Group edges by style into combined <path d="..." /> elements for massive file size savings
    edges_by_style = {}
    for i in range(0, len(edges), 2):
        u, v = edges[i], edges[i+1]
        if color_by_depth and max_depth > 0:
            ratio = min(1.0, max(0.0, depth[u] / max_depth))
            rgb = [ratio, 0.898 * (1.0 - ratio), 1.0 - ratio * 0.667]
            col_hex = rgb_to_hex(rgb)
            opacity = "0.55"
        else:
            col_hex = "#94a3b8"
            opacity = "0.35"
        style_key = (col_hex, opacity)
        if style_key not in edges_by_style:
            edges_by_style[style_key] = []
        edges_by_style[style_key].append(f"M{x[u]:.1f} {y[u]:.1f}L{x[v]:.1f} {y[v]:.1f}")
        
    for (col_hex, opacity), path_parts in edges_by_style.items():
        d_str = "".join(path_parts)
        lines.append(f'  <path d="{d_str}" stroke="{col_hex}" stroke-opacity="{opacity}" stroke-width="{stroke_w:.2f}" stroke-linecap="round" fill="none" />')
    
    # Group nodes by (color, radius)
    buf_idx = unique_labels.index('BUF') if 'BUF' in unique_labels else -1
    base_r = max(vb_w, vb_h) * 0.0065 * (node_size / 0.5)
    nodes_by_style = {}
    for i in range(n):
        label_idx = labels[i]
        l = unique_labels[label_idx] if label_idx < len(unique_labels) else ''
        r = base_r * 0.55 if label_idx == buf_idx else base_r
        
        if node_mask_colors[i]:
            rgb = node_mask_colors[i]
        elif color_by_depth and max_depth > 0:
            ratio = min(1.0, max(0.0, depth[i] / max_depth))
            rgb = [ratio, 0.898 * (1.0 - ratio), 1.0 - ratio * 0.667]
        elif l.startswith('in:'):
            rgb = [0.0, 0.898, 1.0]
        elif l.startswith('out:'):
            rgb = [1.0, 0.0, 0.333]
        elif l in CELL_STYLES:
            rgb = CELL_STYLES[l]
        else:
            rgb = [1.0, 0.4, 0.0]
            
        col_hex = rgb_to_hex(rgb)
        style_key = (col_hex, r)
        if style_key not in nodes_by_style:
            nodes_by_style[style_key] = []
        nodes_by_style[style_key].append((x[i], y[i]))
        
    for (col_hex, r), pts in nodes_by_style.items():
        lines.append(f'  <g fill="{col_hex}">')
        for cx, cy in pts:
            lines.append(f'    <circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.2f}" />')
        lines.append('  </g>')
        
    lines.append('</svg>')
    
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    with open(output_file, 'w') as out_f:
        out_f.write('\n'.join(lines))
    print(f"Generated {output_file} ({os.path.getsize(output_file)} bytes)")

def main():
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    jobs = [
        {"src": "data/ripple_adder_32x32x1_layout.json", "node_size": 0.5, "color_by_depth": False},
        {"src": "data/brent_kung_adder_32x32x1_layout.json", "node_size": 0.5, "color_by_depth": False},
        {"src": "data/right_shifter_32x5x1_layout.json", "node_size": 0.8, "color_by_depth": False, "masks": ["data/right_shifter_32x5x1_mask.json"], "mask_colors": ["#ffa500"]},
        {"src": "data/wallace_multiplier_16x16_layout.json", "node_size": 0.5, "color_by_depth": True, "masks": ["data/wallace_multiplier_16x16_mask_brent_kung_adder.json", "data/wallace_multiplier_16x16_mask_wallace_rec.json"], "mask_colors": ["#ffa500", "#8b5cf6"]},
        {"src": "data/triangle_32_layout.json", "node_size": 0.5, "color_by_depth": True},
        {"src": "data/triangle_32_layout_bfs.json", "node_size": 0.5, "color_by_depth": True},
        {"src": "data/triangle_32_layout_largest.json", "node_size": 0.5, "color_by_depth": True},
        {"src": "data/grid_10x15_layout.json", "node_size": 0.5, "color_by_depth": True},
        {"src": "data/grid_skip_16x16_layout.json", "node_size": 0.5, "color_by_depth": True},
        {"src": "data/ring_20_layout.json", "node_size": 0.5, "color_by_depth": True},
        {"src": "data/tube_10x15_layout.json", "node_size": 0.5, "color_by_depth": True},
        {"src": "data/chain_20x20_layout.json", "node_size": 0.5, "color_by_depth": True},
        {"src": "data/tree_10x15_layout.json", "node_size": 0.5, "color_by_depth": True},
        {"src": "data/medusa_36x8_layout.json", "node_size": 0.3, "color_by_depth": True}
    ]
    
    for j in jobs:
        src_path = os.path.join(root_dir, j["src"])
        filename = os.path.basename(j["src"]).replace('.json', '.svg')
        out_path = os.path.join(root_dir, "data", "fallbacks", filename)
        masks = [os.path.join(root_dir, m) for m in j.get("masks", [])]
        generate_svg(
            src_path, out_path,
            node_size=j.get("node_size", 0.5),
            color_by_depth=j.get("color_by_depth", False),
            mask_files=masks,
            mask_colors=j.get("mask_colors")
        )

if __name__ == "__main__":
    main()
