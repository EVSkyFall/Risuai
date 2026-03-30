/**
 * serverCBSUtils.cjs — Utility functions for server-side CBS engine
 * Ported from: infunctions.ts, util.ts, chatVar.svelte.ts
 */
'use strict';

// ─── RPN Calculator (from infunctions.ts) ───
function toRPN(expression) {
    let outputQueue = '';
    let operatorStack = [];
    const operators = {
        '+': { precedence: 2, associativity: 'Left' },
        '-': { precedence: 2, associativity: 'Left' },
        '*': { precedence: 3, associativity: 'Left' },
        '/': { precedence: 3, associativity: 'Left' },
        '^': { precedence: 4, associativity: 'Left' },
        '%': { precedence: 3, associativity: 'Left' },
        '<': { precedence: 1, associativity: 'Left' },
        '>': { precedence: 1, associativity: 'Left' },
        '|': { precedence: 1, associativity: 'Left' },
        '&': { precedence: 1, associativity: 'Left' },
        '\u2264': { precedence: 1, associativity: 'Left' },
        '\u2265': { precedence: 1, associativity: 'Left' },
        '=': { precedence: 1, associativity: 'Left' },
        '\u2260': { precedence: 1, associativity: 'Left' },
        '!': { precedence: 5, associativity: 'Right' },
    };
    const operatorsKeys = Object.keys(operators);
    expression = expression.replace(/\s+/g, '');
    let expression2 = [];
    let lastToken = '';
    for (let i = 0; i < expression.length; i++) {
        const char = expression[i];
        if (char === '-' && (i === 0 || operatorsKeys.includes(expression[i - 1]) || expression[i - 1] === '(')) {
            lastToken += char;
        } else if (operatorsKeys.includes(char)) {
            expression2.push(lastToken !== '' ? lastToken : '0');
            lastToken = '';
            expression2.push(char);
        } else {
            lastToken += char;
        }
    }
    expression2.push(lastToken !== '' ? lastToken : '0');
    expression2.forEach(token => {
        if (parseFloat(token) || token === '0') {
            outputQueue += token + ' ';
        } else if (operatorsKeys.includes(token)) {
            while (operatorStack.length > 0 &&
                ((operators[token].associativity === 'Left' &&
                    operators[token].precedence <= operators[operatorStack[operatorStack.length - 1]].precedence) ||
                    (operators[token].associativity === 'Right' &&
                        operators[token].precedence < operators[operatorStack[operatorStack.length - 1]].precedence))) {
                outputQueue += operatorStack.pop() + ' ';
            }
            operatorStack.push(token);
        }
    });
    while (operatorStack.length > 0) {
        outputQueue += operatorStack.pop() + ' ';
    }
    return outputQueue.trim();
}

function calculateRPN(expression) {
    let stack = [];
    expression.split(' ').forEach(token => {
        if (parseFloat(token) || token === '0') {
            stack.push(parseFloat(token));
        } else {
            let [b, a] = [stack.pop(), stack.pop()];
            switch (token) {
                case '+': stack.push(a + b); break;
                case '-': stack.push(a - b); break;
                case '*': stack.push(a * b); break;
                case '/': stack.push(a / b); break;
                case '^': stack.push(a ** b); break;
                case '%': stack.push(a % b); break;
                case '<': stack.push(a < b ? 1 : 0); break;
                case '>': stack.push(a > b ? 1 : 0); break;
                case '|': stack.push(a || b); break;
                case '&': stack.push(a && b); break;
                case '\u2264': stack.push(a <= b ? 1 : 0); break;
                case '\u2265': stack.push(a >= b ? 1 : 0); break;
                case '=': stack.push(a === b ? 1 : 0); break;
                case '\u2260': stack.push(a !== b ? 1 : 0); break;
                case '!': stack.push(b ? 0 : 1); break;
            }
        }
    });
    return stack.length === 0 ? 0 : stack.pop();
}

/**
 * Server-side executeRPNCalculation
 * @param {string} text
 * @param {Function} getChatVarFn - (key) => string
 * @param {Function} getGlobalChatVarFn - (key) => string
 */
function executeRPNCalculation(text, getChatVarFn, getGlobalChatVarFn) {
    text = text.replace(/\$([a-zA-Z0-9_]+)/g, (_, p1) => {
        const v = getChatVarFn(p1);
        const parsed = parseFloat(v);
        return isNaN(parsed) ? '0' : parsed.toString();
    }).replace(/@([a-zA-Z0-9_]+)/g, (_, p1) => {
        const v = getGlobalChatVarFn(p1);
        const parsed = parseFloat(v);
        return isNaN(parsed) ? '0' : parsed.toString();
    })
        .replace(/&&/g, '&').replace(/\|\|/g, '|')
        .replace(/<=/g, '\u2264').replace(/>=/g, '\u2265')
        .replace(/==/g, '=').replace(/!=/g, '\u2260')
        .replace(/null/gi, '0');
    return calculateRPN(toRPN(text));
}

/**
 * calcString with injected chatVar functions
 */
function createCalcString(getChatVarFn, getGlobalChatVarFn) {
    return function calcString(text) {
        let depthText = [''];
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '(') {
                depthText.push('');
            } else if (text[i] === ')' && depthText.length > 1) {
                let result = executeRPNCalculation(depthText.pop(), getChatVarFn, getGlobalChatVarFn);
                depthText[depthText.length - 1] += result;
            } else {
                depthText[depthText.length - 1] += text[i];
            }
        }
        return executeRPNCalculation(depthText.join(''), getChatVarFn, getGlobalChatVarFn);
    };
}

// ─── sfc32 PRNG (from util.ts) ───
function sfc32(a, b, c, d) {
    return function () {
        a |= 0; b |= 0; c |= 0; d |= 0;
        let t = (a + b | 0) + d | 0;
        d = d + 1 | 0;
        a = b ^ b >>> 9;
        b = c + (c << 3) | 0;
        c = (c << 21 | c >>> 11);
        c = c + t | 0;
        return (t >>> 0) / 4294967296;
    };
}

function pickHashRand(cid, word) {
    let hashAddress = 5515;
    const rand = (w) => {
        for (let counter = 0; counter < w.length; counter++) {
            hashAddress = ((hashAddress << 5) + hashAddress) + w.charCodeAt(counter);
        }
        return hashAddress;
    };
    const randF = sfc32(rand(word), rand(word), rand(word), rand(word));
    const v = cid % 1000;
    for (let i = 0; i < v; i++) randF();
    return randF();
}

// ─── dateTimeFormat ───
function dateTimeFormat(format, timestamp) {
    const date = timestamp ? new Date(timestamp * 1000) : new Date();
    return format
        .replace(/YYYY/g, date.getFullYear().toString())
        .replace(/YY/g, (date.getFullYear() % 100).toString().padStart(2, '0'))
        .replace(/MM/g, (date.getMonth() + 1).toString().padStart(2, '0'))
        .replace(/M/g, (date.getMonth() + 1).toString())
        .replace(/DD/g, date.getDate().toString().padStart(2, '0'))
        .replace(/D/g, date.getDate().toString())
        .replace(/HH/g, date.getHours().toString().padStart(2, '0'))
        .replace(/H/g, date.getHours().toString())
        .replace(/hh/g, (date.getHours() % 12 || 12).toString().padStart(2, '0'))
        .replace(/h/g, (date.getHours() % 12 || 12).toString())
        .replace(/mm/g, date.getMinutes().toString().padStart(2, '0'))
        .replace(/m/g, date.getMinutes().toString())
        .replace(/ss/g, date.getSeconds().toString().padStart(2, '0'))
        .replace(/s/g, date.getSeconds().toString())
        .replace(/A/g, date.getHours() >= 12 ? 'PM' : 'AM')
        .replace(/a/g, date.getHours() >= 12 ? 'pm' : 'am');
}

// ─── Server-side chatVar (from chatVar.svelte.ts) ───
function parseKeyValue(str) {
    if (!str) return [];
    return str.split('\n').map(line => {
        const idx = line.indexOf('=');
        if (idx === -1) return null;
        return [line.substring(0, idx).trim(), line.substring(idx + 1).trim()];
    }).filter(Boolean);
}

/**
 * @param {string} key
 * @param {object} db - Database object
 * @param {number} charIndex - selected character index
 */
function getChatVar(key, db, charIndex) {
    const char = db.characters[charIndex];
    if (!char) return 'null';
    const chat = char.chats[char.chatPage];
    chat.scriptstate = chat.scriptstate || {};
    const state = chat.scriptstate['$' + key];
    if (state === undefined || state === null) {
        const defaultVariables = parseKeyValue(char.defaultVariables)
            .concat(parseKeyValue(db.templateDefaultVariables));
        const findResult = defaultVariables.find(f => f[0] === key);
        if (findResult) return findResult[1];
        return 'null';
    }
    return state.toString();
}

function setChatVar(key, value, db, charIndex) {
    const char = db.characters[charIndex];
    if (!char) return;
    const chat = char.chats[char.chatPage];
    chat.scriptstate = chat.scriptstate || {};
    chat.scriptstate['$' + key] = value;
}

function getGlobalChatVar(key, db) {
    return (db.globalChatVariables && db.globalChatVariables[key]) || 'null';
}

// ─── Utility exports ───
function safeStructuredClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function makeArray(arr) {
    return JSON.stringify(arr);
}

function parseArraySafe(str) {
    try { return JSON.parse(str); }
    catch { return []; }
}

function parseDictSafe(str) {
    try { return JSON.parse(str); }
    catch { return {}; }
}

module.exports = {
    createCalcString,
    pickHashRand,
    sfc32,
    dateTimeFormat,
    getChatVar,
    setChatVar,
    getGlobalChatVar,
    safeStructuredClone,
    makeArray,
    parseArraySafe,
    parseDictSafe,
    parseKeyValue,
};
