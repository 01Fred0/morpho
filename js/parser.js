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

function getNumericValue(arg) {
    if (arg === null) return null;
    const clean = arg.replace(/_/g, '');
    if (clean.startsWith('0b')) return parseInt(clean.slice(2), 2);
    if (clean.startsWith('0x')) return parseInt(clean.slice(2), 16);
    return parseInt(clean, 10);
}

function tokenize(code) {
    const tokens = [];
    const regex = /\s*(?:#.*|([a-zA-Z_]\w*)|(0b[01_]+|0x[0-9a-fA-F_]+|\d+)|(@[a-zA-Z_]\w*)|([()\[\],:=\-]))/g;
    let m;
    let line = 1;
    while ((m = regex.exec(code))) {
        for (let i = 0; i < m[0].length; i++) {
            if (m[0][i] === '\n') line++;
        }
        if (m[1]) tokens.push(['IDENT', m[1], line]);
        else if (m[2]) tokens.push(['NUM', m[2], line]);
        else if (m[3]) tokens.push(['DECORATOR', m[3], line]);
        else if (m[4]) tokens.push(['OP', m[4], line]);
    }
    tokens.push(['EOF', '', line]);
    return tokens;
}

function parse(code) {
    const tokens = tokenize(code);
    let pos = 0;

    const syntaxError = (msg, line) => {
        const err = new Error(msg);
        err.line = line;
        return err;
    };

    const peek = () => tokens[pos];
    const peekAhead = (n) => tokens[pos + n];
    const next = () => tokens[pos++];
    const check = (type, val) => peek()?.[0] === type && (val === undefined || peek()[1] === val);
    const match = (type, val) => check(type, val) ? next() : null;
    const consume = (type, val) => {
        const t = next();
        if (t[0] !== type || (val !== undefined && t[1] !== val)) {
            throw syntaxError(`Syntax Error: Expected ${type} '${val || ''}', got ${t[0]} '${t[1]}' at line ${t[2]}`, t[2]);
        }
        return t[1];
    };

    const luts = [];
    const cells = [];
    let tmpCounter = 0;
    let currentCell = null;

    const emitSSA = (op, args, targets = null, overrides = null) => {
        const t = targets || [`_tmp_${tmpCounter++}`];
        const inst = { targets: t, op, args };
        if (overrides && Object.keys(overrides).length > 0) {
            inst.overrides = overrides;
        }
        currentCell.ssa.push(inst);
        return t[0];
    };

    const parseCSV = (parseItem) => {
        const res = [];
        do { res.push(parseItem()); } while (match('OP', ','));
        return res;
    };

    const parseArg = () => {
        if (peek()?.[0] === 'IDENT' && peekAhead(1)?.[0] === 'OP' && peekAhead(1)?.[1] === '=') {
            const name = consume('IDENT');
            consume('OP', '=');
            const val = parseExpr();
            return { type: 'KWARG', name, val };
        }
        return { type: 'ARG', val: parseExpr() };
    };

    const parseExpr = (targets = null) => {
        if (check('NUM')) {
            const t = next();
            if (targets) {
                throw syntaxError(`Syntax Error: Invalid assignment: RHS must be a function call or slice/index, got '${t[1]}' at line ${t[2]}`, t[2]);
            }
            return t[1];
        }
        const startToken = peek();
        let base = consume('IDENT');
        if (match('OP', '(')) {
            const parsedArgs = check('OP', ')') ? [] : parseCSV(parseArg);
            consume('OP', ')');
            
            const args = [];
            const overrides = {};
            parsedArgs.forEach(arg => {
                if (arg.type === 'KWARG') {
                    overrides[arg.name] = arg.val;
                } else {
                    args.push(arg.val);
                }
            });
            return emitSSA(base, args, targets, overrides);
        } else if (match('OP', '[')) {
            const sliceTokens = [];
            while (!check('OP', ']')) sliceTokens.push(next()[1]);
            consume('OP', ']');
            const parts = sliceTokens.join('').split(':');
            if (parts.length === 1) return emitSSA('INDEX', [base, parts[0]], targets);
            const args = [base, parts[0] || null, parts[1] || null, parts[2] || null];
            return emitSSA('SLICE', args, targets);
        }
        if (targets) {
            throw syntaxError(`Syntax Error: Invalid assignment: RHS must be a function call or slice/index, got '${base}' at line ${startToken[2]}`, startToken[2]);
        }
        return base;
    };

    const parseCell = () => {
        let fallback = null;
        if (match('DECORATOR', '@morpho') && match('OP', '(')) {
            consume('IDENT', 'fallback');
            consume('OP', '=');
            fallback = check('NUM') ? consume('NUM') : consume('IDENT');
            consume('OP', ')');
        }
        consume('IDENT', 'def');
        const name = consume('IDENT');
        consume('OP', '(');
        const inputs = check('OP', ')') ? [] : parseCSV(() => consume('IDENT'));
        consume('OP', ')');
        consume('OP', ':');
        currentCell = { name, inputs, outputs: [], fallback, ssa: [] };
    };

    const parseStatement = () => {
        if (check('EOF')) return;

        if (match('IDENT', 'return')) {
            currentCell.outputs = parseCSV(parseExpr);
            cells.push(currentCell);
            currentCell = null;
            return;
        }

        const targets = parseCSV(() => consume('IDENT'));
        consume('OP', '=');

        if (!currentCell) {
            consume('IDENT', 'LUT');
            consume('OP', '(');
            const arityStr = consume('NUM');
            consume('OP', ',');
            const valStr = consume('NUM');
            const val = getNumericValue(valStr);
            consume('OP', ')');
            luts.push({ name: targets[0], arity: parseInt(arityStr, 10), value: val });
            return;
        }

        parseExpr(targets);
    };

    while (!check('EOF')) {
        if (check('DECORATOR') || check('IDENT', 'def')) {
            parseCell();
        } else {
            parseStatement();
        }
    }

    return { luts, cells };
}

function formatSSA(ast) {
    const lutsPart = (!ast.luts || ast.luts.length === 0) ? "" :
        "LUTs:\n" + ast.luts.map(lut => {
            const bitWidth = 1 << lut.arity;
            let binStr = lut.value.toString(2).padStart(bitWidth, "0");
            if (lut.arity >= 3) binStr = binStr.match(/.{1,4}/g).join("_");
            return `  ${lut.name} = LUT(${lut.arity}, 0b${binStr}) [Dec: ${lut.value}, Hex: 0x${lut.value.toString(16).toUpperCase()}]`;
        }).join("\n") + "\n\n";

    const cellsPart = (!ast.cells || ast.cells.length === 0) ? "" :
        "Cells & SSA:\n" + ast.cells.map(c => {
            const fallbackStr = c.fallback ? `(fallback=${c.fallback})` : "";
            const ssaLines = c.ssa.map(inst => 
                `    ${inst.targets.join(", ")} = ${inst.op}(${inst.args.map(a => a === null ? "_" : a).join(", ")})`
            ).join("\n");
            return `@morpho${fallbackStr}\ndef ${c.name}(${c.inputs.join(", ")}):\n${ssaLines ? ssaLines + "\n" : ""}    return ${c.outputs.join(", ")}`;
        }).join("\n\n") + "\n";

    return lutsPart + cellsPart;
}

export {
    getNumericValue,
    tokenize,
    parse,
    formatSSA
};
