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

import os

# Universal SVG Tag Generator
def tag(name, content="", **attrs):
    attr_str = "".join(f' {k.rstrip("_").replace("_", "-")}="{v}"' for k, v in attrs.items() if v is not None)
    return f'  <{name}{attr_str}>{content}</{name}>\n' if content else f'  <{name}{attr_str} />\n'

# Procedural Drawing Helpers
def draw_vertical_pill(f, x, y, w, h, label, code):
    f.write(tag('rect', x=x, y=y, width=w, height=h, rx=8, class_='helper-box'))
    for i, char in enumerate(label):
        cy = y + h/2 + (i - (len(label) - 1)/2.0) * 20 + 4
        f.write(tag('text', char, x=x+w/2, y=cy, class_='helper-text', text_anchor='middle'))
    if code:
        cy = y - 12 if y < 200 else y + h + 20
        f.write(tag('text', code, x=x+w/2, y=cy, class_='code-text', text_anchor='middle'))

def draw_subcell(f, x, y, w, h, title, subtitle, code, ports):
    f.write(tag('rect', x=x, y=y, width=w, height=h, rx=8, class_='cell-box'))
    f.write(tag('text', title, x=x+w/2, y=y+55, class_='cell-title', text_anchor='middle'))
    f.write(tag('text', subtitle, x=x+w/2, y=y+73, class_='cell-subtitle', text_anchor='middle'))
    cy = y - 12 if y < 200 else y + h + 20
    f.write(tag('text', code, x=x+w/2, y=cy, class_='code-text', text_anchor='middle'))
    for name, px, py, anchor in ports:
        f.write(tag('text', name, x=px, y=py, class_='port-label', text_anchor=anchor))

def draw_bus_lines(f, x1, x2, y_list, stroke):
    for y in y_list:
        f.write(tag('line', x1=x1, y1=y, x2=x2, y2=y, stroke=stroke))

def draw_bus_curves(f, x_start, x_end, y_starts, y_ends, stroke):
    dx = (x_end - x_start) * 0.35
    for y_s, y_e in zip(y_starts, y_ends):
        d = f"M {x_start} {y_s} C {x_start + dx:.1f} {y_s}, {x_end - dx:.1f} {y_e}, {x_end} {y_e}"
        f.write(tag('path', d=d, stroke=stroke, fill="none"))

def generate_svg():
    # Relative path calculation
    script_dir = os.path.dirname(os.path.abspath(__file__))
    svg_path = os.path.normpath(os.path.join(script_dir, "../data/ripple_recursion.svg"))
    os.makedirs(os.path.dirname(svg_path), exist_ok=True)
    
    # Layout Coordinates Grid
    x_input_start = 50
    x_parent = 100
    x_split = 210
    splitter_w = 30
    x_split_out = x_split + splitter_w # 240
    x_cell = 380
    cell_w = 160
    x_cell_out = x_cell + cell_w # 540
    x_cat = 610
    cat_w = 30
    x_cat_out = x_cat + cat_w # 640
    x_sum_end = 790
    parent_w = 640

    y_parent = 54
    parent_h = 420
    y_upper_top = 110
    y_lower_top = 310
    cell_h = 120
    y_cat_top = 210

    # Carry Line Anchor
    x_carry = x_cell + cell_w / 2 # 460

    # Procedural generation of port coordinate lists
    spacing = 14
    k = 4
    mid_upper = y_upper_top + cell_h / 2 # 170
    mid_lower = y_lower_top + cell_h / 2 # 370
    mid_cat = y_cat_top + cell_h / 2     # 270

    y_A_u = [mid_upper + (i - (2*k - 1)/2.0) * spacing for i in range(k)]
    y_A_l = [mid_upper + (i + k - (2*k - 1)/2.0) * spacing for i in range(k)]
    y_A = y_A_u + y_A_l

    y_B_u = [mid_lower + (i - (2*k - 1)/2.0) * spacing for i in range(k)]
    y_B_l = [mid_lower + (i + k - (2*k - 1)/2.0) * spacing for i in range(k)]
    y_B = y_B_u + y_B_l

    y_cat_u = [mid_cat + (i - (2*k - 1)/2.0) * spacing for i in range(k)]
    y_cat_l = [mid_cat + (i + k - (2*k - 1)/2.0) * spacing for i in range(k)]
    y_sum = y_cat_u + y_cat_l

    y_ports_u_sum = [mid_upper + (i - (k - 1)/2.0) * spacing for i in range(k)]
    y_ports_l_sum = [mid_lower + (i - (k - 1)/2.0) * spacing for i in range(k)]

    # Compute label anchors dynamically
    y_lbl_A = sum(y_A) / len(y_A) + 4
    y_lbl_B = sum(y_B) / len(y_B) + 4
    y_lbl_sum = sum(y_sum) / len(y_sum) + 4

    y_u_a, y_u_b, y_u_sum = sum(y_A_u)/k + 4, sum(y_A_l)/k + 4, sum(y_ports_u_sum)/k + 4
    y_l_a, y_l_b, y_l_sum = sum(y_B_u)/k + 4, sum(y_B_l)/k + 4, sum(y_ports_l_sum)/k + 4

    with open(svg_path, "w") as f:
        # SVG Header and Styles
        f.write('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n')
        f.write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 840 520" width="100%" height="100%">\n')
        f.write("""  <defs>
    <style>
      text { font-family: system-ui, -apple-system, sans-serif; }
      .title { font-size: 18px; font-weight: 600; fill: #F8FAFC; }
      .boundary-box { stroke: #10B981; stroke-width: 1.5; fill: #0F172A; fill-opacity: 0.4; }
      .boundary-title { font-size: 13px; font-weight: 600; fill: #10B981; }
      .cell-box { stroke: #38BDF8; stroke-width: 2; fill: #1E293B; }
      .cell-title { font-size: 14px; font-weight: bold; fill: #F8FAFC; }
      .cell-subtitle { font-size: 11px; fill: #94A3B8; }
      .helper-box { stroke: #64748B; stroke-width: 1.2; fill: #0F172A; }
      .helper-text { font-size: 11px; font-weight: bold; fill: #CBD5E1; text-anchor: middle; }
      .port-label { font-size: 11px; fill: #94A3B8; }
      .code-text { font-family: monospace; font-size: 11px; fill: #5d5; font-weight: bold;}
      .bus-label { font-size: 13px; font-weight: bold; }
    </style>
    <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1.5 L 10 5 L 0 8.5 z" fill="#F59E0B" />
    </marker>
  </defs>\n\n""")

        # Background Canvas
        f.write(tag('rect', width='100%', height='100%', fill='#0B0F19', rx=12))

        # Parent Cell Boundary Box
        f.write(tag('rect', x=x_parent, y=y_parent, width=parent_w, height=parent_h, rx=16, class_='boundary-box'))
        f.write(tag('text', 'ripple_adder', x=x_parent + 20, y=y_parent + 23, class_='boundary-title'))

        # Splitters & CAT Box
        draw_vertical_pill(f, x_split, y_upper_top, splitter_w, cell_h, "SPLIT", "a0, a1 = SPLIT(a)")
        draw_vertical_pill(f, x_split, y_lower_top, splitter_w, cell_h, "SPLIT", "b0, b1 = SPLIT(b)")
        draw_vertical_pill(f, x_cat, y_cat_top, cat_w, cell_h, "CAT", "sum = CAT(s0, s1)")

        # Carry Wires
        y_c_in_start, y_c_in_end = y_parent + parent_h + 28, y_lower_top + cell_h + 3
        y_c_mid_start, y_c_mid_end = y_lower_top, y_upper_top + cell_h + 3
        y_c_out_start, y_c_out_end = y_upper_top, y_parent - 42

        f.write(tag('line', x1=x_carry, y1=y_c_in_start, x2=x_carry, y2=y_c_in_end, stroke='#F59E0B', stroke_width=2, marker_end='url(#arrow)')) # c_in
        f.write(tag('line', x1=x_carry, y1=y_c_mid_start, x2=x_carry, y2=y_c_mid_end, stroke='#F59E0B', stroke_width=2, marker_end='url(#arrow)')) # c_mid
        f.write(tag('line', x1=x_carry, y1=y_c_out_start, x2=x_carry, y2=y_c_out_end, stroke='#F59E0B', stroke_width=2, marker_end='url(#arrow)')) # c_out

        f.write(tag('text', 'c_in', x=x_carry+10, y=y_parent+parent_h+16, class_='bus-label', fill='#F59E0B'))
        f.write(tag('text', 'c_mid', x=x_carry+10, y=(y_lower_top+y_upper_top+cell_h)/2+5, class_='bus-label', fill='#F59E0B'))
        f.write(tag('text', 'c_out', x=x_carry+10, y=y_parent-10, class_='bus-label', fill='#F59E0B'))

        # Subcells
        ports_u = [("a1", x_cell + 12, y_u_a - 4, "start"), ("b1", x_cell + 12, y_u_b - 4, "start"), ("c", x_carry, y_upper_top + cell_h - 12, "middle"), ("c_out", x_carry, y_upper_top + 15, "middle"), ("s1", x_cell_out - 8, y_u_sum - 4, "end")]
        ports_l = [("a0", x_cell + 12, y_l_a - 4, "start"), ("b0", x_cell + 12, y_l_b - 4, "start"), ("c", x_carry, y_lower_top + cell_h - 12, "middle"), ("c_out", x_carry, y_lower_top + 15, "middle"), ("s0", x_cell_out - 8, y_l_sum - 4, "end")]
        draw_subcell(f, x_cell, y_upper_top, cell_w, cell_h, "ripple_adder", "[upper half]", "s1, c_out = ripple_adder(a1, b1, c_mid)", ports_u)
        draw_subcell(f, x_cell, y_lower_top, cell_w, cell_h, "ripple_adder", "[lower half]", "s0, c_mid = ripple_adder(a0, b0, c_in)", ports_l)

        # Bus Lines
        draw_bus_lines(f, x_input_start, x_split, y_A, "#38BDF8") # A
        draw_bus_lines(f, x_input_start, x_split, y_B, "#A78BFA") # B
        draw_bus_lines(f, x_split_out, x_cell, y_A_u, "#38BDF8")   # a1
        draw_bus_lines(f, x_split_out, x_cell, y_B_l, "#A78BFA")   # b0
        draw_bus_lines(f, x_cat_out, x_sum_end, y_cat_u, "#A78BFA") # Sum upper half (MSB)
        draw_bus_lines(f, x_cat_out, x_sum_end, y_cat_l, "#38BDF8") # Sum lower half (LSB)

        # Bus Labels
        f.write(tag('text', 'a', x=x_input_start-10, y=y_lbl_A, class_='bus-label', text_anchor='end', fill='#38BDF8'))
        f.write(tag('text', 'b', x=x_input_start-10, y=y_lbl_B, class_='bus-label', text_anchor='end', fill='#A78BFA'))
        f.write(tag('text', 'sum', x=x_sum_end+10, y=y_lbl_sum, class_='bus-label', text_anchor='start', fill='#E2E8F0'))

        # Bus Curves
        draw_bus_curves(f, x_split_out, x_cell, y_A_l, y_B_u, "#38BDF8") # a0 curve
        draw_bus_curves(f, x_split_out, x_cell, y_B_u, y_A_l, "#A78BFA") # b1 curve
        draw_bus_curves(f, x_cell_out, x_cat, y_ports_u_sum, y_cat_u, "#A78BFA") # s1 curve
        draw_bus_curves(f, x_cell_out, x_cat, y_ports_l_sum, y_cat_l, "#38BDF8") # s0 curve

        f.write('</svg>\n')

if __name__ == "__main__":
    generate_svg()
    print("Done!")
