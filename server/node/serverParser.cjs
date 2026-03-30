/**
 * serverParser.cjs — Server-side risuChatParser
 * Ported from: parser.svelte.ts (risuChatParser, matcher, blockStartMatcher, blockEndMatcher)
 *
 * Pure logic port — no Svelte, no DOMPurify, no markdown-it, no katex.
 * Browser deps replaced:
 *   DBState.db        → arg.db (parameter)
 *   get(selectedCharID)→ arg.charIndex (parameter)
 *   findCharacterbyId → db.characters search
 *   getChatVar/getGlobalChatVar → injected from serverCBSUtils
 */
'use strict';

const { createServerCBS } = require('./serverCBS.cjs');
const { getChatVar, getGlobalChatVar, parseArraySafe, parseDictSafe, makeArray } = require('./serverCBSUtils.cjs');

// ─── risuEscape ───
function risuEscape(text) {
    return text.replace(/[{}()]/g, (f) => {
        switch (f) {
            case '{': return '\uE9B8';
            case '}': return '\uE9B9';
            case '(': return '\uE9BA';
            case ')': return '\uE9BB';
            default: return f;
        }
    });
}

function trimLines(p1) {
    return p1.split('\n').map(v => v.trimStart()).join('\n').trim();
}

// ─── Simple character finder for group chats ───
function findCharacterById(db, id) {
    if (!id || !db.characters) return { name: 'Unknown Character' };
    for (const char of db.characters) {
        if (char.chaId === id || char.name === id) return char;
    }
    return { name: 'Unknown Character' };
}

// ─── blockStartMatcher ───
function blockStartMatcher(p1, matcherArg, getCV, getGCV) {
    if (p1.startsWith('#if') || p1.startsWith('#if_pure ')) {
        const statement = p1.split(' ', 2);
        const state = statement[1];
        if (state === 'true' || state === '1') {
            return { type: p1.startsWith('#if_pure') ? 'ifpure' : 'parse' };
        }
        return { type: 'ignore' };
    }

    if (p1.startsWith('#when')) {
        if (p1.startsWith('#when ')) {
            const statement = p1.split(' ', 2);
            const state = statement[1];
            return { type: (state === 'true' || state === '1') ? 'newif' : 'newif-falsy' };
        }
        else if (p1.startsWith('#when::')) {
            const statement = p1.split('::').slice(1);
            if (statement.length === 1) {
                const state = statement[0];
                return { type: (state === 'true' || state === '1') ? 'newif' : 'newif-falsy' };
            }
            let mode = 'normal';
            const isTruthy = (s) => s === 'true' || s === '1';

            while (statement.length > 1) {
                const condition = statement.pop();
                const operator = statement.pop();
                switch (operator) {
                    case 'not': statement.push(isTruthy(condition) ? '0' : '1'); break;
                    case 'keep': mode = 'keep'; statement.push(condition); break;
                    case 'legacy': mode = 'legacy'; statement.push(condition); break;
                    case 'and': { const c2 = statement.pop(); statement.push((isTruthy(condition) && isTruthy(c2)) ? '1' : '0'); break; }
                    case 'or': { const c2 = statement.pop(); statement.push((isTruthy(condition) || isTruthy(c2)) ? '1' : '0'); break; }
                    case 'is': { const c2 = statement.pop(); statement.push(condition === c2 ? '1' : '0'); break; }
                    case 'isnot': { const c2 = statement.pop(); statement.push(condition !== c2 ? '1' : '0'); break; }
                    case 'var': { const v = getCV(condition); statement.push(isTruthy(v) ? '1' : '0'); break; }
                    case 'toggle': { const v = getGCV('toggle_' + condition); statement.push(isTruthy(v) ? '1' : '0'); break; }
                    case 'vis': { const v = getCV(statement.pop()); statement.push(v === condition ? '1' : '0'); break; }
                    case 'visnot': { const v = getCV(statement.pop()); statement.push(v !== condition ? '1' : '0'); break; }
                    case 'tis': { const v = getGCV('toggle_' + statement.pop()); statement.push(v === condition ? '1' : '0'); break; }
                    case 'tisnot': { const v = getGCV('toggle_' + statement.pop()); statement.push(v !== condition ? '1' : '0'); break; }
                    case '>': { const c2 = statement.pop(); statement.push(parseFloat(c2) > parseFloat(condition) ? '1' : '0'); break; }
                    case '<': { const c2 = statement.pop(); statement.push(parseFloat(c2) < parseFloat(condition) ? '1' : '0'); break; }
                    case '>=': { const c2 = statement.pop(); statement.push(parseFloat(c2) >= parseFloat(condition) ? '1' : '0'); break; }
                    case '<=': { const c2 = statement.pop(); statement.push(parseFloat(c2) <= parseFloat(condition) ? '1' : '0'); break; }
                    default: statement.push(isTruthy(condition) ? '1' : '0'); break;
                }
            }
            const finalCondition = statement[0];
            if (isTruthy(finalCondition)) {
                switch (mode) {
                    case 'keep': return { type: 'newif', type2: 'keep' };
                    case 'legacy': return { type: 'parse' };
                    default: return { type: 'newif' };
                }
            } else {
                switch (mode) {
                    case 'keep': return { type: 'newif-falsy', type2: 'keep' };
                    case 'legacy': return { type: 'ignore' };
                    default: return { type: 'newif-falsy' };
                }
            }
        }
        else {
            return { type: 'newif-falsy' };
        }
    }
    if (p1 === '#pure') return { type: 'pure' };
    if (p1 === '#pure_display' || p1 === '#puredisplay') return { type: 'pure-display' };
    if (p1 === '#code') return { type: 'normalize' };
    if (p1.startsWith('#escape')) {
        const t2 = p1.substring(7).trim();
        return { type: 'escape', mode: t2 === '::keep' ? 'keep' : undefined };
    }
    if (p1.startsWith('#each')) {
        let t2 = p1.substring(5).trim();
        let mode;
        if (t2.startsWith('::keep ')) { mode = 'keep'; t2 = t2.substring(7).trim(); }
        if (t2.startsWith('as ')) { t2 = t2.substring(3).trim(); }
        return { type: 'each', type2: t2, mode };
    }
    if (p1.startsWith('#func')) {
        const statement = p1.split(' ');
        if (statement.length > 1) return { type: 'function', funcArg: statement.slice(1) };
    }
    return { type: 'nothing' };
}

// ─── blockEndMatcher ───
function blockEndMatcher(p1, type, matcherArg, parseArrayFn) {
    const p1Trimmed = p1.trim();
    switch (type.type) {
        case 'pure':
        case 'pure-display':
        case 'function': return p1Trimmed;
        case 'parse': return trimLines(p1Trimmed);
        case 'each': return type.mode === 'keep' ? p1 : trimLines(p1Trimmed);
        case 'ifpure': return p1;
        case 'newif':
        case 'newif-falsy': {
            const lines = p1.split("\n");
            if (lines.length === 1) {
                const elseIndex = p1.indexOf('{{:else}}');
                if (elseIndex !== -1) {
                    return type.type === 'newif' ? p1.substring(0, elseIndex) : p1.substring(elseIndex + 9);
                } else {
                    return type.type === 'newif' ? p1 : '';
                }
            }
            const elseLine = lines.findIndex(v => v.trim() === '{{:else}}');
            if (elseLine !== -1 && type.type === 'newif') lines.splice(elseLine);
            if (elseLine !== -1 && type.type === 'newif-falsy') lines.splice(0, elseLine + 1);
            if (elseLine === -1 && type.type === 'newif-falsy') return '';
            if (type.type2 !== 'keep') {
                while (lines.length > 0 && lines[0].trim() === '') lines.shift();
                while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
            }
            return lines.join('\n');
        }
        case 'normalize': {
            return p1Trimmed.trim().replaceAll('\n', '').replaceAll('\t', '')
                .replaceAll(/\\u([0-9A-Fa-f]{4})/g, (match, p1) => String.fromCharCode(parseInt(p1, 16)))
                .replaceAll(/\\(.)/g, (match, p1) => {
                    switch (p1) {
                        case 'n': return '\n';
                        case 'r': return '\r';
                        case 't': return '\t';
                        case 'b': return '\b';
                        case 'f': return '\f';
                        case 'v': return '\v';
                        case 'a': return '\a';
                        case 'x': return '\x00';
                        default: return p1;
                    }
                });
        }
        case 'escape': return risuEscape(type.mode === 'keep' ? p1 : p1Trimmed);
        default: return '';
    }
}

// ─── legacyBlockMatcher ───
function legacyBlockMatcher(p1, matcherArg) {
    const bn = p1.indexOf('\n');
    if (bn === -1) return null;
    const logic = p1.substring(0, bn);
    const content = p1.substring(bn + 1);
    const statement = logic.split(" ", 2);
    switch (statement[0]) {
        case 'if': {
            if (["", "0", "-1"].includes(statement[1])) return '';
            return content.trim();
        }
    }
    return null;
}

// ─── matcher ───
function matcher(p1, matcherArg, vars, matcherMap, calcStringFn) {
    try {
        if (p1.startsWith('? ')) {
            return calcStringFn(p1.substring(2)).toString();
        }
        const colonIndex = p1.indexOf(':');
        let splited;
        if (colonIndex !== -1 && p1[colonIndex + 1] === ':') {
            splited = p1.split('::');
        } else {
            splited = p1.split(':');
        }
        const name = splited[0].toLocaleLowerCase().replace(/[\s_-]/g, '');
        const args = splited.slice(1);
        const callback = matcherMap.get(name);
        if (callback) return callback(p1, matcherArg, args, vars);
    } catch (error) { }
    return null;
}

/**
 * Server-side risuChatParser — direct port from parser.svelte.ts
 *
 * @param {string} da - Input template string
 * @param {object} arg - Parser arguments
 * @param {number} [arg.chatID] - Current chat message index (-1 for template)
 * @param {object} arg.db - Database object
 * @param {number} arg.charIndex - Selected character index
 * @param {string|object} [arg.chara] - Character override
 * @param {boolean} [arg.rmVar] - Remove variables mode
 * @param {object} [arg.var] - Temporary variables
 * @param {boolean} [arg.tokenizeAccurate] - Accurate tokenization mode
 * @param {boolean} [arg.consistantChar] - Use placeholder names
 * @param {boolean} [arg.visualize] - Display mode
 * @param {string} [arg.role] - Message role
 * @param {boolean} [arg.runVar] - Run var operations
 * @param {Map} [arg.functions] - User-defined CBS functions
 * @param {number} [arg.callStack] - Recursion depth
 * @param {object} [arg.cbsConditions] - CBS conditions
 * @param {Map} [arg._matcherMap] - Pre-initialized matcherMap (for perf)
 * @param {Function} [arg._calcString] - Pre-initialized calcString
 * @param {Function} [arg._getCV] - Pre-initialized getChatVar
 * @param {Function} [arg._getGCV] - Pre-initialized getGlobalChatVar
 * @returns {string}
 */
function risuChatParser(da, arg) {
    if (!da || typeof da !== 'string') return da || '';
    arg = arg || {};
    const chatID = arg.chatID ?? -1;
    const db = arg.db;
    if (!db) throw new Error('serverParser: arg.db is required');
    const charIndex = arg.charIndex ?? 0;
    const aChara = arg.chara;
    let chara = null;

    if (aChara) {
        if (typeof aChara !== 'string' && aChara.type === 'group') {
            if (aChara.chats[aChara.chatPage].message.length > 0) {
                const gc = findCharacterById(db, aChara.chats[aChara.chatPage].message.at(-1).saying ?? '');
                if (gc.name !== 'Unknown Character') chara = gc;
            } else { chara = 'bot'; }
        } else { chara = aChara; }
    }
    if (arg.tokenizeAccurate) {
        const selchar = chara ?? db.characters[charIndex];
        if (!selchar) chara = 'bot';
    }

    // Initialize or reuse matcherMap
    let matcherMap = arg._matcherMap;
    let calcStringFn = arg._calcString;
    let getCV = arg._getCV;
    let getGCV = arg._getGCV;

    if (!matcherMap) {
        const self = (text, innerArg) => risuChatParser(text, {
            ...innerArg, db, charIndex,
            _matcherMap: matcherMap, _calcString: calcStringFn,
            _getCV: getCV, _getGCV: getGCV,
        });
        const cbsResult = createServerCBS({
            db, charIndex,
            risuChatParser: self,
            appVer: arg.appVer || '0.0.0',
        });
        matcherMap = cbsResult.matcherMap;
        // Bind chatVar functions
        const CBSUtils = require('./serverCBSUtils.cjs');
        getCV = (key) => CBSUtils.getChatVar(key, db, charIndex);
        getGCV = (key) => CBSUtils.getGlobalChatVar(key, db);
        calcStringFn = CBSUtils.createCalcString(getCV, getGCV);
    }

    let pointer = 0;
    let nested = [""];
    let stackType = new Uint8Array(512);
    let pureModeNest = new Map();
    let pureModeNestType = new Map();
    let blockNestType = new Map();
    let commentMode = false;
    let commentLatest = [""];
    let commentV = new Uint8Array(512);
    let thinkingMode = false;
    let tempVar = {};
    let functions = arg.functions ?? new Map();

    arg.callStack = (arg.callStack ?? 0) + 1;
    if (arg.callStack > 20) return 'ERROR: Call stack limit reached';

    const matcherObj = {
        chatID, chara,
        rmVar: arg.rmVar ?? false,
        db, var: arg.var ?? null,
        tokenizeAccurate: arg.tokenizeAccurate ?? false,
        displaying: arg.visualize ?? false,
        role: arg.role,
        runVar: arg.runVar ?? false,
        consistantChar: arg.consistantChar ?? false,
        cbsConditions: arg.cbsConditions ?? {},
        callStack: arg.callStack,
        triggerId: arg.triggerId || '',
        getNested: () => nested,
        setNestedRoot: (val) => { nested[0] = val; },
    };

    da = da.replace(/\\<(user|char|bot)\\>/gi, '{{$1}}');
    const isPureMode = () => pureModeNest.size > 0;

    while (pointer < da.length) {
        switch (da[pointer]) {
            case '{': {
                if (da[pointer + 1] !== '{' && da[pointer + 1] !== '#') {
                    nested[0] += da[pointer]; break;
                }
                pointer++;
                nested.unshift('');
                stackType[nested.length] = 1;
                break;
            }
            case '#': {
                if (da[pointer + 1] !== '}' || nested.length === 1 || stackType[nested.length] !== 1) {
                    nested[0] += da[pointer]; break;
                }
                pointer++;
                const dat = nested.shift();
                const mc = legacyBlockMatcher(dat, matcherObj);
                nested[0] += mc ?? `{#${dat}#}`;
                break;
            }
            case '}': {
                if (da[pointer + 1] !== '}' || nested.length === 1 || stackType[nested.length] !== 1) {
                    nested[0] += da[pointer]; break;
                }
                pointer++;
                const dat = nested.shift();
                if (dat.startsWith('#') || dat.startsWith(':')) {
                    if (isPureMode()) {
                        nested[0] += `{{${dat}}}`;
                        if (dat !== ':else') {
                            nested.unshift('');
                            stackType[nested.length] = 6;
                        }
                        break;
                    }
                    const matchResult = blockStartMatcher(dat, matcherObj, getCV, getGCV);
                    if (matchResult.type === 'nothing') {
                        nested[0] += `{{${dat}}}`;
                        break;
                    } else {
                        nested.unshift('');
                        stackType[nested.length] = 5;
                        blockNestType.set(nested.length, matchResult);
                        if (['ignore', 'pure', 'each', 'function', 'pure-display', 'escape'].includes(matchResult.type)) {
                            pureModeNest.set(nested.length, true);
                            pureModeNestType.set(nested.length, "block");
                        }
                        break;
                    }
                }
                if (dat.startsWith('/') && !dat.startsWith('//')) {
                    if (stackType[nested.length] === 5) {
                        const blockType = blockNestType.get(nested.length);
                        if (['ignore', 'pure', 'each', 'function', 'pure-display', 'escape'].includes(blockType.type)) {
                            pureModeNest.delete(nested.length);
                            pureModeNestType.delete(nested.length);
                        }
                        blockNestType.delete(nested.length);
                        const dat2 = nested.shift();
                        const matchResult2 = blockEndMatcher(dat2, blockType, matcherObj, parseArraySafe);
                        if (blockType.type === 'each') {
                            const asIndex = blockType.type2.lastIndexOf(' as ');
                            let sub = blockType.type2.substring(asIndex + 4).trim();
                            let array = parseArraySafe(blockType.type2.substring(0, asIndex));
                            if (asIndex === -1) {
                                const subind = blockType.type2.lastIndexOf(' ');
                                if (subind === -1) break;
                                sub = blockType.type2.substring(subind + 1);
                                array = parseArraySafe(blockType.type2.substring(0, subind));
                            }
                            let added = '';
                            for (let i = 0; i < array.length; i++) {
                                added += matchResult2.replaceAll(`{{slot::${sub}}}`,
                                    typeof array[i] === 'string' ? array[i] : JSON.stringify(array[i]));
                            }
                            da = da.substring(0, pointer + 1) + (blockType.mode === 'keep' ? added : added.trim()) + da.substring(pointer + 1);
                            break;
                        }
                        if (blockType.type === 'function') {
                            functions.set(blockType.funcArg[0], {
                                data: matchResult2,
                                arg: blockType.funcArg.slice(1)
                            });
                            break;
                        }
                        if (blockType.type === 'pure-display') {
                            nested[0] += matchResult2.replaceAll('{{', '\\{\\{').replaceAll('}}', '\\}\\}');
                            break;
                        }
                        if (matchResult2 === '') break;
                        nested[0] += matchResult2;
                        break;
                    }
                    if (stackType[nested.length] === 6) {
                        const sft = nested.shift();
                        nested[0] += sft + `{{${dat}}}`;
                        break;
                    }
                }
                if (dat.startsWith('call::')) {
                    if (arg.callStack && arg.callStack > 20) {
                        nested[0] += 'ERROR: Call stack limit reached';
                        break;
                    }
                    const argData = dat.split('::').slice(1);
                    const funcName = argData[0];
                    const func = functions.get(funcName);
                    if (func) {
                        let data = func.data;
                        for (let i = 0; i < argData.length; i++) {
                            data = data.replaceAll(`{{arg::${i}}}`, argData[i]);
                        }
                        arg.functions = functions;
                        nested[0] += risuChatParser(data, {
                            ...arg, db, charIndex,
                            _matcherMap: matcherMap, _calcString: calcStringFn,
                            _getCV: getCV, _getGCV: getGCV,
                        });
                        break;
                    }
                }
                const mc = isPureMode() ? null : matcher(dat, matcherObj, tempVar, matcherMap, calcStringFn);
                if (!mc && mc !== '') {
                    nested[0] += `{{${dat}}}`;
                } else if (typeof mc === 'string') {
                    nested[0] += mc;
                } else {
                    nested[0] += mc.text;
                    tempVar = mc.var;
                    if (tempVar['__force_return__']) {
                        return tempVar['__return__'] ?? 'null';
                    }
                }
                break;
            }
            default: {
                nested[0] += da[pointer];
                break;
            }
        }
        pointer++;
    }

    if (commentMode) {
        nested = commentLatest;
        stackType = commentV;
        commentMode = false;
    }
    if (nested.length === 1) return nested[0];
    let result = '';
    while (nested.length > 1) {
        let dat = (stackType[nested.length] === 1) ? '{{' : "<";
        dat += nested.shift();
        result = dat + result;
    }
    return nested[0] + result;
}

module.exports = {
    risuChatParser,
    risuEscape,
};
