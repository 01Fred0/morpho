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

"""
Tiny MorphoHDL: A self-contained Hardware Description Language and JIT compiler.

This module is organized into the following major architectural sections:

  - MorphoHDL primitives
    Core decorator `@morpho`, lookup table generator `LUT`, bus splitting
    operations (`SPLIT`), and shape-aligned slice primitives (`LSLICE`, `HSLICE`).
    
  - ripple_adder
    Recursive ripple-carry adder cell highlighting basic structural logic.
    
  - brent_kung_adder
    A high-performance parallel-prefix Brent-Kung adder implementation.
    
  - wallace_multiplier
    A recursive, early-terminating carry-save Wallace multiplier tree.
    
  - mux
    Recursive multiplexer trees supporting standard selection and wide
    bus-routing selection with shape-preserving fallback mechanics.
    
  - right_shifter
    Logarithmic right shifter supporting logical and arithmetic shifting.
    
  - Circuit Runner
    The dynamic execution engine (`CircuitRunner`) facilitating parallel
    multi-sample immediate execution of MorphoHDL circuits.
    
  - Circuit Compiler
    The symbolic execution compiler (`CircuitCompiler`) translating python
    functions into optimized gate-level netlists with constant propagation
    and dead code elimination (DCE).
    
  - tests
    Unified test suite verifying correct behavior of adders, multipliers,
    multiplexers, and shifters in both dynamic and compiled JIT modes.
"""

from functools import wraps, partial, lru_cache
from collections import namedtuple, Counter
import inspect
import numpy as np
import contextvars


#@MARK: MorphoHDL primitives
G_Runner = contextvars.ContextVar('G_Runner', default=None)
G_Overrides = contextvars.ContextVar('G_Overrides', default={})

def LUT(arg_n, lut, name=None):
    if name is None:
        # a hack to pull the LUT name from the assignment statement
        ctx = inspect.stack()[1].code_context
        name = ctx[0].split('=')[0].strip() if ctx else f'LUT{arg_n}_{lut:x}'
    def f(*args):
        assert len(args) == arg_n
        if any(len(a) == 0 for a in args):
            raise IndexError
        runner = G_Runner.get() or CircuitRunner
        return runner.run_lut(lut, args, name)
    f.__name__ = name
    return f

def morpho(f=None, fallback=None):
    if f is None:
        return partial(morpho, fallback=fallback)
    @wraps(f)
    def wrapper(*args, **new_overrides):
        token = None
        overrides = {**G_Overrides.get(), **new_overrides}
        if new_overrides:
            token = G_Overrides.set(overrides)

        target_f = overrides.get(f.__name__, f)
        runner = G_Runner.get() or CircuitRunner
        try:
            return runner.run_cell(target_f, args)
        except IndexError:
            if callable(fallback):
                return fallback(*args)
            elif isinstance(fallback, int):
                return args[fallback]
            raise
        finally:
            if token:
                G_Overrides.reset(token)
    return wrapper

def SPLIT(x):
    n = len(x)
    if n < 2:
        raise IndexError("Cannot split bus of width < 2")
    return x[:n//2], x[n//2:]

def LSLICE(x, ref):
    n = len(np.atleast_1d(ref))
    if len(x)<n:
        raise IndexError
    return x[:n], x[n:]

def HSLICE(x, ref):
    n = len(np.atleast_1d(ref))
    if len(x)<n:
        raise IndexError
    return x[:-n], x[-n:]

def REPEAT(x, ref):
    return np.repeat(x, len(ref), 0)

def CAT(*arrays):
    return np.concatenate(_normalize_shapes(arrays))


ZERO = np.zeros((1,), dtype=np.int32)
ONE  = np.ones((1,), dtype=np.int32)
VOID = np.zeros((0,), dtype=np.int32)

# MORPHO_BEGIN
#@MARK: ripple_adder
# Define basic building blocks (Lookup Tables) for later usage.
# We allow primitives with >2 inputs because this more closely
# reflects the reality of modern VLSI, where a standard cell can
# be as complex as a full-adder or a 4-way multiplexer.

Not  = LUT(1, 0b01)
And  = LUT(2, 0b1000)
Or   = LUT(2, 0b1110)
Xor  = LUT(2, 0b0110)
Xor3 = LUT(3, 0b1001_0110)   # 3-input XOR (odd parity) for Sum
Maj3 = LUT(3, 0b1110_1000)   # 3-input Majority logic for Carry Out

@morpho                         # Base case cell (1-bit full adder)
def full_adder(a, b, c_in):     # a: [1], b: [1], c_in: [1] -> sum: [1], c_out: [1]
    sum = Xor3(a, b, c_in)
    c_out = Maj3(a, b, c_in)
    return sum, c_out

@morpho(fallback=full_adder)    # Recursive definition (falls back to full_adder at width 1)
def ripple_adder(a, b, c):      # a: [N], b: [N], c: [1] -> sum: [N], c_out: [1]
    a0, a1 = SPLIT(a)           # Split input busses into lower/upper halves
    b0, b1 = SPLIT(b)           # or trigger fallback when bus size is <2
    s0, c_mid = ripple_adder(a0, b0, c)       # Solve lower bits, extract mid carry
    s1, c_out = ripple_adder(a1, b1, c_mid)   # Solve upper bits with mid carry
    sum = CAT(s0, s1)           # Concatenate lower/upper sums back together
    return sum, c_out


#@MARK: brent_kung_adder
# Determine carry-out given Propagate, Generate, and Carry-in signals
carry_op = LUT(3, 0b1110_1100) # p, g, c_in -> c_out = (p & c_in) | g

# Base case: a reduced 1-bit full adder returning intermediate P and G signals
# and missing Carry-out signal
@morpho
def bk_base(a, b, c):           # a: [1], b: [1], c: [1] -> sum: [1], p: [1], g: [1]
    p = Xor(a, b)
    g = And(a, b)
    sum = Xor(p, c)  
    return sum, p, g

@morpho(fallback=bk_base)
def bk_rec(a, b, c_in):         # a: [N], b: [N], c_in: [1] -> sum: [N], p: [1], g: [1]
    a0, a1 = SPLIT(a)           # Divide-and-conquer bus splitting
    b0, b1 = SPLIT(b)           # (same structure as the ripple-carry adder)
    s0, p0, g0 = bk_rec(a0, b0, c_in)
    c_mid = carry_op(p0, g0, c_in)  # Compute carry shortcut (c_mid) for the upper half
    s1, p1, g1 = bk_rec(a1, b1, c_mid)
    sum = CAT(s0, s1)
    p = And(p0, p1)             # Combine prefix signals for the entire segment
    g = carry_op(p1, g1, g0)
    return sum, p, g

@morpho
def brent_kung_adder(a, b, c):  # a: [N], b: [N], c: [1] -> sum: [N], c_out: [1]
    sum, p, g = bk_rec(a, b, c)
    c_out = carry_op(p, g, c)   # Compute the global carry-out
    return sum, c_out


#@MARK: wallace_multiplier
@morpho
def csa_3to2(a, b, c):          # a: [N], b: [N], c: [N] -> sum: [N], carry: [N]
    sum, carry = full_adder(a, b, c)
    c_shift = CAT(ZERO, carry[:-1])
    return sum, c_shift

@morpho
def csa_4to2(a, b, c, d):       # a: [N], b: [N], c: [N], d: [N] -> sum: [N], carry: [N]
    s1, c1 = csa_3to2(a, b, c)
    sum, carry = csa_3to2(s1, c1, d)
    return sum, carry

# Base case 1: 1xN-bit multiplier.
# The product of a single bit a0 and a bus b is simply a bitwise AND.
@morpho
def wallace_base1(a0, b):        # a0: [1], b: [M] -> s: [M + 1], c: [M + 1]
    s = CAT(And(a0, b), ZERO)     # Expand by 1 bit for alignment headroom
    c = REPEAT(ZERO, s)
    return s, c

# Base case 2: 2xN-bit multiplier.
@morpho(fallback=wallace_base1)
def wallace_base2(a01, b):       # a01: [2], b: [M] -> s: [M + 2], c: [M + 2]
    a0, a1 = SPLIT(a01)
    s = CAT(And(a0, b), ZERO, ZERO)
    c = CAT(ZERO, And(a1, b), ZERO)   # Align upper product
    return s, c

# Recursively computes the Carry-Save representation of the product a * b.
# Output width invariant: len(s_out) == len(c_out) == len(a) + len(b)
@morpho(fallback=wallace_base2)
def wallace_rec(a, b):           # a: [N], b: [M] -> s: [N + M], c: [N + M]
    _ = a[2]                     # Fallback check: requires len(a) >= 3
    a0, a1 = SPLIT(a)
    s0, c0 = wallace_rec(a0, b)
    s1, c1 = wallace_rec(a1, b)
    z0 = REPEAT(ZERO, a0)
    z1 = REPEAT(ZERO, a1)
    s, c = csa_4to2(CAT(s0, z1), 
                    CAT(c0, z1), 
                    CAT(z0, s1),
                    CAT(z0, c1))
    return s, c

# Top-level multiplier. Resolves the carry-save form into the final binary sum.
@morpho
def wallace_multiplier(a, b):    # a: [N], b: [M] -> p: [N + M]
    sum_out, carry_out = wallace_rec(a, b)
    p, _ = brent_kung_adder(sum_out, carry_out, ZERO)
    return p

#@MARK: mux
# Two-input multiplexer standard cell
Mux2 = LUT(3, 0b1100_1010)  # x0, x1, sel -> sel ? x1 : x0 

@morpho(fallback=0)  # Return positional argument #0 (x) on fallback
def mux(x, sel):     # x: [M * 2^S], sel: [S] -> y: [M]
    rest, hi = HSLICE(sel, ONE)  # Slice a single high bit, or trigger fallback
    x0, x1 = SPLIT(x)
    y0 = mux(x0, rest)
    y1 = mux(x1, rest)
    y = Mux2(y0, y1, hi)
    return y

#@MARK: right_shifter
@morpho(fallback=0)
def right_shifter(x, s, pad):    # x: [N], s: [S], pad: [2^level] -> out: [N]
    _, x_rest = LSLICE(x, pad)       # Drop lower len(pad) bits
    _ = x_rest[0]                    # Stop recursion when x_rest is empty
    x_shifted = CAT(x_rest, pad)
    sel_bit, s_rest = LSLICE(s, ONE)
    y = Mux2(x, x_shifted, sel_bit)
    pad2 = CAT(pad, pad)             # Double shift size for next stage (2^(level+1))
    out = right_shifter(y, s_rest, pad2)
    return out

#@MARK: morpho structures

@morpho
def grid_base(x, y):
    z = Xor(x, y)
    return z, z

@morpho
def grid_split(x, y):
    x0, x1 = SPLIT(x)
    y_mid, x0_out = grid(y, x0)
    y_out, x1_out = grid(y_mid, x1)
    x_out = CAT(x0_out, x1_out)
    return x_out, y_out

@morpho(fallback=grid_base)
def grid_1d(x, y):
    y_out, x_out = grid_split(y, x)
    return x_out, y_out

@morpho(fallback=grid_1d)
def grid(x, y):
    x_out, y_out = grid_split(x, y)
    return x_out, y_out

@morpho
def base_skip(x, y):
    return x, y

@morpho
def grid_skip(x, y):
    x_out, y_out = grid(x, y, grid_base=base_skip)
    return x_out, y_out


@morpho(fallback=0)
def triangle(x):
    y = Xor(x[1:], x[:-1])
    z = triangle(Not(y))
    return z

@morpho
def ring(x):
    return And(x, CAT(x[1:],x[0]))

@morpho(fallback=0)
def tube(x, n):
    n0, n1 = SPLIT(n)
    y = tube(x, n0)
    z = ring(y)
    return tube(z, n1)

@morpho(fallback=0)
def chain(x, n):
    n0, n1 = SPLIT(n)
    return chain(Not(chain(x, n0)), n1)

@morpho(fallback=chain)
def tree(x, n):
    y = tube(x, n)
    y0, y1 = SPLIT(y)
    return CAT(tree(y0, n), tree(y1, n))

@morpho
def medusa_half(x, n):
    x = tree(x, n)
    x = tube(x, n)
    x = chain(x, n)
    return x

@morpho
def medusa(x, n):
    a = medusa_half(x, n)
    b = medusa_half(x, n)
    return a, b

# MORPHO_END
#@MARK: Circuit Runner

def _normalize_shapes(arrays):
    arrays = [np.asarray(a) for a in arrays]
    max_ndim = max(max(a.ndim for a in arrays), 1)
    padded = [a[(...,) + (np.newaxis,) * (max_ndim - a.ndim)] for a in arrays]
    target = np.broadcast_shapes(*(arr.shape[1:] for arr in padded))
    return [np.broadcast_to(a, (len(a),)+target) for a in padded]


class CircuitRunner:
    @staticmethod
    def run_lut(lut, args, name):
        args = _normalize_shapes(args)
        idx = 0
        for k, val in enumerate(args):
            idx = idx + ((val.astype(np.int32)) << k)
        out = (lut >> idx) & 1
        return out

    @staticmethod
    def run_cell(f, args):
        return f(*args)

#@MARK: Circuit Compiler

def unpack(a, bit_n):
    return (a >> np.c_[:bit_n])&1
def pack(a):
    return (a << np.c_[:len(a)]).sum(0)

def unpack_lut(lut, arity):
    return unpack(lut, 1<<arity).reshape((2,)*arity)
def pack_lut(bits):
    return pack(bits.reshape(-1,1)).item()

@lru_cache(maxsize=None)
def fix_lut_input(arity, lut, i, val):
    return pack_lut(unpack_lut(lut, arity).take(val, axis=arity - 1 - i))

@lru_cache(maxsize=None)
def merge_lut_inputs(arity, lut, i, j):
    i, j = arity - 1 - i, arity - 1 - j
    D = np.diagonal(unpack_lut(lut, arity), axis1=i, axis2=j)
    return pack_lut(np.moveaxis(D, -1, j - 1 if i < j else j))


def flatten_tree(x):
    if isinstance(x, (tuple, list)):
        return np.concatenate([flatten_tree(item) for item in x])
    return np.asarray(x).ravel()

Op = namedtuple('Op', ['type', 'name', 'lut', 'args'], defaults=(None, None))

class CircuitCompiler:
    def __init__(self, optimize=True):
        self.ops = [Op('CONST', '0'), Op('CONST', '1')]
        self.depths = [0, 0]
        self.inputs = []
        self.outputs = None
        self.optimize = optimize
        self.stats = {'const_elim': 0, 'buf_elim': 0, 'gate_reductions': 0, 'dce_elim': 0}
        self.input_info = []
        self.cell_calls = []

    def add_input(self, name, n):
        self.input_info.append((name, n))
        for i in range(n):
            self.ops.append(Op('INPUT', f'{name}[{i}]'))
            self.depths.append(0)
        end = len(self.ops)
        idx = np.arange(end-n, end)
        self.inputs.append(idx)
        return idx

    def _optimize_gate(self, name, lut, gate_args):
        # propagate constants
        init_arity = len(gate_args)
        const_indices = (np.asarray(gate_args) <= 1).nonzero()[0]
        for k in const_indices[::-1]:
            lut = fix_lut_input(len(gate_args), lut, k, gate_args[k])
            gate_args.pop(k)
        
        # merge duplicate inputs
        representatives = {}
        removals = []
        for k, arg in enumerate(gate_args):
            if arg in representatives:
                removals.append((k, representatives[arg]))
            else:
                representatives[arg] = k
        for k2, k1 in reversed(removals):
            lut = merge_lut_inputs(len(gate_args), lut, k2, k1)
            gate_args.pop(k2)

        # detect and trip ignored inputs
        for k in reversed(range(len(gate_args))):
            arity = len(gate_args)
            lut_f = fix_lut_input(arity, lut, k, 0)
            if lut_f == fix_lut_input(arity, lut, k, 1):
                lut = lut_f
                gate_args.pop(k)

        arity = len(gate_args)
        lut_size = 1 << arity
        all_ones = (1 << lut_size) - 1
        
        if arity == 0 or lut == 0 or lut == all_ones:
            self.stats['const_elim'] += 1
            return int(lut == all_ones)
        if arity == 1 and lut == 0b10:
            self.stats['buf_elim'] += 1
            return gate_args[0]
        
        if arity != init_arity:
            self.stats['gate_reductions'] += 1
            name = f"*{name}"
        gate_idx = len(self.ops)
        self.ops.append(Op('GATE', name, lut, tuple(gate_args)))
        self.depths.append(1 + max(self.depths[arg] for arg in gate_args))
        return gate_idx

    def run_lut(self, lut, args, name):
        n = max(len(a) for a in args)
        outputs = []
        for i in range(n):
            gate_args = list((a[0] if len(a)==1 else a[i]).item() for a in args)
            if self.optimize:
                wire = self._optimize_gate(name, lut, gate_args)
            else:
                wire = len(self.ops)
                self.ops.append(Op('GATE', name, lut, tuple(gate_args)))
                self.depths.append(1 + max(self.depths[arg] for arg in gate_args))
            outputs.append(wire)
            
        return np.array(outputs, dtype=np.int32)

    def strip_unused_gates(self):
        live = np.zeros(len(self.ops), dtype=bool)
        live[:2] = True
        live[flatten_tree((self.inputs, self.outputs))] = True
        
        for i in range(len(self.ops) - 1, -1, -1):
            if live[i]:
                op = self.ops[i]
                if op.type == 'GATE':
                    live[list(op.args)] = True
                    
        mapping = np.cumsum(live) - 1
        
        new_ops = []
        for i in range(len(self.ops)):
            if live[i]:
                op = self.ops[i]
                if op.type == 'GATE':
                    new_args = tuple(mapping[list(op.args)])
                    new_ops.append(Op('GATE', op.name, op.lut, new_args))
                else:
                    new_ops.append(op)
                    
        self.stats['dce_elim'] = len(self.ops) - len(new_ops)
        self.ops = new_ops
        self.depths = self.depths[live]
        self.inputs = [mapping[inp] for inp in self.inputs]
        
        def remap(x):
            if isinstance(x, (list, tuple)):
                return type(x)(remap(item) for item in x)
            return mapping[x]
        self.outputs = remap(self.outputs)

    def run_cell(self, f, args):
        res = f(*args)
        
        # Capture signatures of the cell invocation
        in_widths = tuple(len(np.asarray(arg)) for arg in args)
        if isinstance(res, (tuple, list)):
            out_widths = tuple(len(np.asarray(item)) for item in res)
        else:
            out_widths = (len(np.asarray(res)),)
        self.cell_calls.append((f.__name__, in_widths, out_widths))
        
        return res

    def __call__(self, *inputs):
        sample_n = inputs[0].shape[-1] if len(inputs) > 0 else 1
        vals = np.zeros((len(self.ops), sample_n), dtype=np.int32)
        vals[1] = 1
        
        for idx_array, inp_val in zip(self.inputs, inputs):
            vals[idx_array] = inp_val
            
        first_gate_idx = 2 + sum(len(inp) for inp in self.inputs)
        for i in range(first_gate_idx, len(self.ops)):
            op = self.ops[i]
            idx = sum(val << k for k, val in enumerate(vals[list(op.args)]))
            vals[i] = (op.lut >> idx) & 1
                
        if isinstance(self.outputs, tuple):
            return tuple(vals[out_idx] for out_idx in self.outputs)
        return vals[self.outputs]

    def report(self):
        lines = [
            "=" * 50,
            "Circuit Compilation Report",
            "=" * 50,
            "Inputs:",
            *(f"  - {name}: {size} bits" for name, size in self.input_info),
            "Outputs:"
        ]
        
        out_idx = flatten_tree(self.outputs)
        max_depth = int(self.depths[out_idx].max()) if len(out_idx) > 0 else 0

        if isinstance(self.outputs, tuple):
            sizes = [len(np.asarray(out)) for out in self.outputs]
            lines.append(f"  - Tuple of {len(sizes)} busses: {', '.join(f'{s} bits' for s in sizes)} (Max Logic Depth: {max_depth})")
        else:
            lines.append(f"  - Output: {len(np.asarray(self.outputs))} bits (Max Logic Depth: {max_depth})")
            
        # Group calls by name and signature
        cells = {}
        for name, in_w, out_w in self.cell_calls:
            if name not in cells:
                cells[name] = Counter()
            cells[name][(in_w, out_w)] += 1
            
        lines.append("\nInstantiated Cells:")
        for name in sorted(cells.keys()):
            sig_counts = cells[name]
            total_instances = sum(sig_counts.values())
            lines.append(f"  - {name} ({total_instances} instances):")
            for (in_w, out_w), count in sorted(sig_counts.items(), key=lambda x: x[0][0]):
                in_str = f"({', '.join(map(str, in_w))})"
                out_str = f"({', '.join(map(str, out_w))})"
                lines.append(f"      - {count}x {in_str} -> {out_str}")
            
        gate_counts = Counter(op.name for op in self.ops if op.type == 'GATE')
        total_gates = sum(gate_counts.values())
        unopt_gates = total_gates + sum(self.stats[k] for k in ('const_elim', 'buf_elim', 'dce_elim'))
        
        lines.extend([
            f"\nGate Counts (Total: {total_gates}, Unoptimized: {unopt_gates}):",
            *(f"  - {name}: {count}" for name, count in sorted(gate_counts.items())),
            "\nOptimization Statistics:",
            f"  - Constants eliminated: {self.stats['const_elim']}",
            f"  - Buffers eliminated: {self.stats['buf_elim']}",
            f"  - Gates reduced/simplified: {self.stats['gate_reductions']}",
            f"  - DCE-pruned gates: {self.stats['dce_elim']}",
            "=" * 50
        ])
        
        print("\n".join(lines))


def compile(f, arg_sizes, optimize=True):
    circuit = CircuitCompiler(optimize)
    token = G_Runner.set(circuit)
    args = [circuit.add_input(name, size) for name, size 
            in zip(inspect.signature(f).parameters, arg_sizes)]
    try:
        outputs = f(*args)
        circuit.outputs = outputs
    finally: G_Runner.reset(token)
    
    circuit.depths = np.array(circuit.depths, dtype=np.int32)
    
    if optimize:
        circuit.strip_unused_gates()
        
    return circuit

def jit_runner(f, optimize=True):
    circuits = {}
    @wraps(f)
    def runner(*args):
        arg_sizes = tuple(len(a) for a in args)
        if arg_sizes not in circuits:
            circuit = compile(f, arg_sizes, optimize=optimize)
            circuits[arg_sizes] = circuit
        return circuits[arg_sizes](*args)
    runner._circuits = circuits
    return runner

#@MARK: tests

def test_arithm(f, op, bit_n=[8, 13, 16], sample_n=1024):
    for n in (bit_n if isinstance(bit_n, list) else [bit_n]):
        rng = np.random.default_rng(42)
        a, b = rng.integers(1<<n, size=(2, sample_n))
        if op == '*':
            res = f(unpack(a, n), unpack(b, n))
            assert len(res) == n * 2 and (pack(res) == a * b).all()
        elif op == '+':
            c_in = rng.integers(2, size=sample_n)
            s, c = f(unpack(a, n), unpack(b, n), unpack(c_in, 1))
            s, c = pack(s), pack(c)
            expected = a + b + c_in
            mask = (1<<n)-1
            assert (s == expected & mask).all() and (c == expected >> n).all()
        else:
            assert False


def test_reduction():
    MUX2 = 0b1100_1010
    XOR3 = 0b1001_0110
    
    # 1. Test 3-input mux (n=3, lut=0b1100_1010). Fixing input 2 to 0 -> output should be 2-input identity of index 0 (0b1010)
    assert fix_lut_input(3, MUX2, 2, 0) == 0b1010
    # Fixing input 2 to 1 -> output should be 2-input identity of index 1 (0b1100)
    assert fix_lut_input(3, MUX2, 2, 1) == 0b1100
    
    # 2. Test 3-input mux. Fixing input 1 to 0 -> output should be 2-input function x2?0:x0 (0b0010)
    assert fix_lut_input(3, MUX2, 1, 0) == 0b0010
    # Fixing input 1 to 1 -> output should be 2-input function x2|x0 (0b1110)
    assert fix_lut_input(3, MUX2, 1, 1) == 0b1110

    # 3. Test asymmetric merge cases using Mux2 (lut=0b1100_1010, inputs: x2, x1, x0)
    # Equating select line x2 and input x0 (i=2, j=0) -> x0 ? x1 : x0 = x1 & x0 (0b1000)
    assert merge_lut_inputs(3, MUX2, 2, 0) == 0b1000
    
    # Equating select line x2 and input x1 (i=2, j=1) -> x1 ? x1 : x0 = x1 | x0 (0b1110)
    assert merge_lut_inputs(3, MUX2, 2, 1) == 0b1110
    
    # Equating inputs x1 and x0 (i=1, j=0) -> x2 ? x0 : x0 = x0 (0b1010)
    assert merge_lut_inputs(3, MUX2, 1, 0) == 0b1010

    # 4. Test Xor3 gate (n=3, lut=0b1001_0110).
    # Fixing input 2 to 0 -> output should be 2-input Xor (0b0110)
    assert fix_lut_input(3, XOR3, 2, 0) == 0b0110
    # Fixing input 2 to 1 -> output should be 2-input Xnor (0b1001)
    assert fix_lut_input(3, XOR3, 2, 1) == 0b1001
    # Equating input 2 and 0 (i=2, j=0) -> output should be 2-input identity of index 1 (0b1100)
    assert merge_lut_inputs(3, XOR3, 2, 0) == 0b1100
    # Equating input 1 and 2 (i=1, j=2) -> output should be 2-input identity of index 0 (0b1010)
    assert merge_lut_inputs(3, XOR3, 1, 2) == 0b1010
    
    print("All merge_lut_inputs and fix_lut_input tests passed successfully!")

def test_optimize():
    # 1. Test optimization of And(x, x) -> should reduce to x (0 gates)
    @morpho
    def ckt_dup(x):
        return And(x, x)
    c_dup = compile(ckt_dup, (1,), optimize=True)
    assert len(c_dup.ops) == 3  # CONST 0, CONST 1, INPUT x[0]
    
    # 2. Test optimization of And(x, ZERO) -> should reduce to CONST 0 (0 gates)
    @morpho
    def ckt_const_zero(x):
        return And(x, ZERO)
    c_const_zero = compile(ckt_const_zero, (1,), optimize=True)
    assert len(c_const_zero.ops) == 3
    assert c_const_zero.outputs[0] == 0
    
    # 3. Test optimization of Xor(x, x, ZERO) -> should reduce to CONST 0 (0 gates)
    @morpho
    def ckt_xor_dup(x):
        return Xor3(x, x, ZERO)
    c_xor_dup = compile(ckt_xor_dup, (1,), optimize=True)
    assert len(c_xor_dup.ops) == 3
    assert c_xor_dup.outputs[0] == 0
    
    # 4. Test optimization of Maj3(x, y, x) -> output doesn't depend on y, should reduce to x (0 gates)
    @morpho
    def ckt_ignored(x, y):
        return Maj3(x, y, x)
    c_ignored = compile(ckt_ignored, (1, 1), optimize=True)
    assert len(c_ignored.ops) == 4  # CONST 0, CONST 1, INPUT x[0], INPUT y[0]
    assert c_ignored.outputs[0] == 2  # output points directly to x[0]
    
    # 5. Test optimization of dead code (DCE) -> unused gates should be stripped
    @morpho
    def ckt_dead(x, y):
        u = And(x, y)
        dead = Maj3(x, y, ZERO) # dead gate
        return u
    c_dead = compile(ckt_dead, (1, 1), optimize=True)
    assert len(c_dead.ops) == 5  # CONST 0, CONST 1, INPUT x[0], INPUT y[0], And gate
    assert c_dead.ops[4].name == 'And'
    
    # 6. Compare unoptimized vs optimized sizes of Brent-Kung Adder with constant carry-in
    @morpho
    def bk_with_zero(a, b):
        return brent_kung_adder(a, b, ZERO)
        
    c_bk_unopt = compile(bk_with_zero, (8, 8), optimize=False)
    c_bk_opt = compile(bk_with_zero, (8, 8), optimize=True)
    assert len(c_bk_opt.ops) < len(c_bk_unopt.ops)
    
    # Check execution correctness of optimized Brent-Kung Adder
    rng = np.random.default_rng(42)
    a, b = rng.integers(2, size=(2, 8, 100))
    res_unopt = c_bk_unopt(a, b)
    res_opt = c_bk_opt(a, b)
    assert (res_unopt[0] == res_opt[0]).all() and (res_unopt[1] == res_opt[1]).all()
    
    print("All circuit optimization tests passed successfully!")

def check_mux_config(width_x, width_sel):
    c_mux = compile(mux, (width_x, width_sel), optimize=True)
    num_samples = min(2**(width_x + width_sel), 512)
    rng = np.random.default_rng(42)
    x = rng.integers(2, size=(width_x, num_samples))
    sel = rng.integers(2, size=(width_sel, num_samples))
    
    chunk_size = width_x // (2**width_sel)
    x_reshaped = x.reshape(2**width_sel, chunk_size, -1)
    expected = x_reshaped[pack(sel), :, np.arange(num_samples)].T

    dynamic_out = mux(x, sel)
    assert (dynamic_out == expected).all(), f"Dynamic failed for config x:{width_x}, sel:{width_sel}"
    
    compiled_out = c_mux(x, sel)
    assert (compiled_out == expected).all(), f"Compiled failed for config x:{width_x}, sel:{width_sel}"

def test_mux():
    configs = [
        (8, 3),   # 8-to-1 standard
        (16, 2),  # 4-bit wide 4-to-1 (len(x) > 2**len(sel))
    ]
    for w_x, w_sel in configs:
        check_mux_config(w_x, w_sel)
    print("All mux tests passed successfully!")

def expected_shifter(x, sel, pad):
    w_x, n_samples = x.shape
    n_active = int(np.log2(w_x))
    sel_active = sel[:n_active, :]
    s_vals = pack(sel_active)
    
    shifts = [np.concatenate([x[s:, :], np.repeat(pad, s, axis=0)], axis=0) for s in range(w_x)]
    shifts.append(np.repeat(pad, w_x, axis=0))
    all_shifted = np.array(shifts)  # shape (w_x + 1, w_x, n_samples)
    return all_shifted[s_vals, :, np.arange(n_samples)].T

def check_shifter_config(width_x, pad_val=0):
    width_sel = width_x
    c_shift = compile(right_shifter, (width_x, width_sel, 1), optimize=True)
    num_samples = min(2**(width_x + width_sel), 512)
    rng = np.random.default_rng(42)
    x = rng.integers(2, size=(width_x, num_samples))
    sel = rng.integers(2, size=(width_sel, num_samples))
    pad = np.full((1, num_samples), pad_val, dtype=np.int32)
    
    expected = expected_shifter(x, sel, pad)
    
    dynamic_out = right_shifter(x, sel, pad)
    assert (dynamic_out == expected).all(), f"Dynamic failed for config x:{width_x}, sel:{width_sel}, pad:{pad_val}"
    
    compiled_out = c_shift(x, sel, pad)
    assert (compiled_out == expected).all(), f"Compiled failed for config x:{width_x}, sel:{width_sel}, pad:{pad_val}"

def test_shifter():
    configs = [(8, 0), (8, 1), (16, 0)]
    for w_x, pad_val in configs:
        check_shifter_config(w_x, pad_val)
    print("All right_shifter tests passed successfully!")

def test_grid_skip():
    comp = compile(grid_skip, (4, 4))
    
    # Assert that override successfully produced exactly zero gates
    gate_counts = [op for op in comp.ops if op.type == 'GATE']
    assert len(gate_counts) == 0, f"Expected 0 gates, but got {len(gate_counts)}: {[g.name for g in gate_counts]}"
    
    x = np.array([[1, 0, 1, 0]], dtype=np.int32).T
    y = np.array([[0, 1, 0, 1]], dtype=np.int32).T
    res_x, res_y = comp(x, y)
    assert (res_x == x).all(), "Result X does not match input x"
    assert (res_y == y).all(), "Result Y does not match input y"
    print("All grid_skip tests passed successfully!")

def expected_triangle(x):
    if len(x) <= 1:
        return x
    y = x[1:] ^ x[:-1]
    z = ~y & 1
    return expected_triangle(z)

def test_triangle():
    for width in [1, 2, 4, 8, 16]:
        rng = np.random.default_rng(42)
        x = rng.integers(2, size=(width, 100))
        expected = expected_triangle(x)
        dyn_out = triangle(x)
        assert (dyn_out == expected).all(), f"Dynamic triangle failed for width {width}"
        
        comp = compile(triangle, (width,))
        comp_out = comp(x)
        assert (comp_out == expected).all(), f"Compiled triangle failed for width {width}"
    print("All triangle tests passed successfully!")

if __name__ == "__main__":
    test_reduction()
    test_optimize()
    test_mux()
    test_shifter()
    test_grid_skip()
    test_triangle()

    for name, f, op in [
        ("Ripple Adder", ripple_adder, '+'),
        ("Brent-Kung Adder", brent_kung_adder, '+'),
        ("Wallace Multiplier", wallace_multiplier, '*')
    ]:
        print(f"Testing {name} (Dynamic)...")
        test_arithm(f, op)
        print(f"Testing {name} (JIT)...")
        test_arithm(jit_runner(f), op)
        
    print("All tests passed!")

    compile(wallace_multiplier, (16, 16)).report()


    # compile(ripple_adder, (64, 64, 1)).report()
    # compile(brent_kung_adder, (64, 64, 1)).report()