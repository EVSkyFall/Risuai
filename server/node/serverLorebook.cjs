/**
 * serverLorebook.cjs — Server-side lorebook engine
 * Ported from: lorebook.svelte.ts (loadLoreBookV3Prompt)
 *
 * Replaced:
 *   selectedCharID/DBState.db  → db, charIndex params
 *   getChatVar/setChatVar      → from serverCBSUtils
 *   tokenize                   → simple chars/4 approximation
 *   CCardLib.decorator.parse   → inline decorator parser
 *   findCharacterbyId          → simple db search
 *   getModuleLorebooks         → optional param
 *   pickHashRand               → from serverCBSUtils
 *   safeStructuredClone        → JSON parse/stringify
 */
'use strict';

const { getChatVar, setChatVar, pickHashRand } = require('./serverCBSUtils.cjs');

/**
 * Simple decorator parser — replaces CCardLib.decorator.parse
 * Parses @@decorator_name arg1 arg2 lines from content.
 * Calls callback(name, args) for each. Returns content with decorators stripped.
 * If callback returns false, the decorator line is preserved in the output.
 */
function parseDecorators(content, callback) {
    const lines = content.split('\n');
    const output = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('@@')) {
            const parts = trimmed.substring(2).split(/\s+/);
            const name = parts[0];
            const args = parts.slice(1);
            const result = callback(name, args);
            if (result === false) {
                // Decorator not recognized, preserve text
                output.push(line);
            }
            // If result is undefined/true, decorator consumed (stripped)
        } else {
            output.push(line);
        }
    }
    return output.join('\n').trim();
}

/**
 * Simple token approximation: chars / 4
 */
function approxTokens(text) {
    return Math.ceil((text || '').length / 4);
}

/**
 * Find character by ID in db
 */
function findCharacterById(db, id) {
    if (!id || !db.characters) return null;
    for (const char of db.characters) {
        if (char.chaId === id || char.name === id) return char;
    }
    return null;
}

function safeStructuredClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Server-side loadLoreBookV3Prompt
 *
 * @param {object} opts
 * @param {object} opts.db - Database object
 * @param {number} opts.charIndex - Selected character index
 * @param {loreBook[]} [opts.moduleLorebooks=[]] - Module lorebooks
 * @returns {{actives, matchLog, disabledUIPrompts}}
 */
function loadLoreBookV3Prompt(opts) {
    const { db, charIndex, moduleLorebooks = [] } = opts;
    const char = db.characters[charIndex];
    const page = char.chatPage;
    const characterLore = char.globalLore ?? [];
    const chatLore = char.chats[page].localLore ?? [];
    const fullLore = safeStructuredClone(characterLore.concat(chatLore).concat(moduleLorebooks));
    const currentChat = char.chats[page].message;
    const loreDepth = char.loreSettings?.scanDepth ?? db.loreBookDepth ?? 10;
    const loreToken = char.loreSettings?.tokenBudget ?? db.loreBookToken ?? 500;
    const fullWordMatchingSetting = char.loreSettings?.fullWordMatching ?? false;
    const chatLength = currentChat.length + 1;
    const recursiveScanning = char.loreSettings?.recursiveScanning ?? true;
    let recursivePrompt = [];
    let matchLog = [];
    let disabledUIPrompts = [];

    // Bound chatVar functions
    const getCV = (key) => getChatVar(key, db, charIndex);
    const setCV = (key, value) => setChatVar(key, value, db, charIndex);

    // ─── searchMatch (inner function from original) ───
    const searchMatch = (messages, arg) => {
        const sliced = messages.slice(messages.length - arg.searchDepth, messages.length);
        arg.keys = arg.keys.map(key => key.trim()).filter(key => key.length > 0);

        let mList = sliced.map((msg, i) => {
            if (msg.role === 'user') {
                return {
                    source: `message ${i} by user`,
                    prompt: `\x01{{${db.username}}}:` + msg.data + '\x01',
                    data: msg.data
                };
            } else {
                const charName = msg.name ??
                    (msg.saying ? (findCharacterById(db, msg.saying)?.name ?? null) : null) ??
                    char.name;
                return {
                    source: `message ${i} by char`,
                    prompt: `\x01{{${charName}}}:` + msg.data + '\x01',
                    data: msg.data
                };
            }
        }).concat(
            arg.dontSearchWhenRecursive ? [] : recursivePrompt.map(msg => ({
                source: 'lorebook ' + msg.source,
                prompt: msg.prompt,
                data: msg.data
            }))
        );

        if (arg.regex) {
            for (const mText of mList) {
                for (const regexString of arg.keys) {
                    if (!regexString.startsWith('/')) return false;
                    const regexFlag = regexString.split('/').pop();
                    if (regexFlag) {
                        arg.keys[0] = regexString.replace('/' + regexFlag, '');
                        try {
                            const regex = new RegExp(arg.keys[0], regexFlag);
                            if (regex.test(mText.data)) {
                                matchLog.push({ prompt: mText.prompt, source: mText.source, activated: regexString });
                                return true;
                            }
                        } catch { return false; }
                    }
                }
            }
            return false;
        }

        mList = mList.map(m => ({
            source: m.source,
            prompt: m.prompt.toLocaleLowerCase().replace(/\{\{\/\/(.+?)\}\}/g, '').replace(/\{\{comment:(.+?)\}\}/g, ''),
            data: m.data.toLocaleLowerCase().replace(/\{\{\/\/(.+?)\}\}/g, '').replace(/\{\{comment:(.+?)\}\}/g, '')
        }));

        let allMode = arg.all ?? false;
        let allModeMatched = true;

        for (const m of mList) {
            let mText = m.data;
            if (arg.fullWordMatching) {
                const splited = mText.split(' ');
                for (const key of arg.keys) {
                    if (splited.includes(key.toLocaleLowerCase())) {
                        matchLog.push({ prompt: m.prompt, source: m.source, activated: key });
                        if (!allMode) return true;
                    } else if (allMode) { allModeMatched = false; }
                }
            } else {
                mText = mText.replace(/ /g, '');
                for (const key of arg.keys) {
                    const realKey = key.toLocaleLowerCase().replace(/ /g, '');
                    if (mText.includes(realKey)) {
                        matchLog.push({ prompt: m.prompt, source: m.source, activated: key });
                        if (!allMode) return true;
                    } else if (allMode) { allModeMatched = false; }
                }
            }
        }
        if (allMode && allModeMatched) return true;
        return false;
    };

    // ─── Main activation loop ───
    let matching = true;
    let actives = [];
    let activatedIndexes = [];
    let matchTimes = 0;
    let keepActivateAfterMatch = false;
    let dontActivateAfterMatch = false;

    while (matching) {
        matching = false;
        matchTimes++;
        if (matchTimes > 100) break; // safety limit

        for (let i = 0; i < fullLore.length; i++) {
            if (activatedIndexes.includes(i)) continue;
            if (!fullLore[i].alwaysActive && !fullLore[i].key) continue;

            let activated = true;
            let pos = '';
            let inject = null;
            let depth = 0;
            let scanDepth = loreDepth;
            let order = fullLore[i].insertorder;
            let priority = fullLore[i].insertorder;
            let forceState = 'none';
            let role = 'system';
            let searchQueries = [];
            let fullWordMatching = fullWordMatchingSetting;
            let dontSearchWhenRecursive = false;
            let itemRecursive = 'global';

            // Child mode
            if (fullLore[i].mode === 'child') {
                activated = false;
                for (let j = 0; j < i; j++) {
                    if (fullLore[j].id === fullLore[i].id) {
                        if (!activatedIndexes.includes(j)) {
                            fullLore[i].comment = fullLore[j].comment;
                            fullLore[i].content = fullLore[j].content;
                            fullLore[i].alwaysActive = true;
                            activated = true;
                        }
                        break;
                    }
                }
            }

            // Parse decorators
            const content = parseDecorators(fullLore[i].content, (name, arg) => {
                switch (name) {
                    case 'end': pos = 'depth'; depth = 0; return;
                    case 'activate_only_after': {
                        const int = parseInt(arg[0]);
                        if (Number.isNaN(int)) return false;
                        if (chatLength < int) activated = false;
                        return;
                    }
                    case 'activate_only_every': {
                        const int = parseInt(arg[0]);
                        if (Number.isNaN(int)) return false;
                        if (chatLength % int !== 0) activated = false;
                        return;
                    }
                    case 'keep_activate_after_match': {
                        const vara = getCV('__internal_ka_' + (fullLore[i].id ?? pickHashRand(5555, fullLore[i].content).toString()));
                        if (vara === 'true') forceState = 'activate';
                        else keepActivateAfterMatch = true;
                        return false;
                    }
                    case 'dont_activate_after_match': {
                        const vara = getCV('__internal_da_' + (fullLore[i].id ?? pickHashRand(5555, fullLore[i].content).toString()));
                        if (vara === 'true') forceState = 'deactivate';
                        else dontActivateAfterMatch = true;
                        return false;
                    }
                    case 'depth':
                    case 'reverse_depth': {
                        const int = parseInt(arg[0]);
                        if (Number.isNaN(int)) return false;
                        depth = int;
                        pos = name === 'depth' ? 'depth' : 'reverse_depth';
                        return;
                    }
                    case 'instruct_depth':
                    case 'reverse_instruct_depth':
                    case 'instruct_scan_depth': return false;
                    case 'role': {
                        if (['user', 'assistant', 'system'].includes(arg[0])) { role = arg[0]; return; }
                        return false;
                    }
                    case 'scan_depth': scanDepth = parseInt(arg[0]); return;
                    case 'is_greeting': {
                        const int = parseInt(arg[0]);
                        if (Number.isNaN(int)) return false;
                        if (((char.chats[page].fmIndex ?? -1) + 1) !== int) activated = false;
                        return;
                    }
                    case 'position': {
                        if (arg[0].startsWith('pt_') || ["after_desc", "before_desc", "personality", "scenario"].includes(arg[0])) {
                            pos = arg[0]; return;
                        }
                        return false;
                    }
                    case 'inject_lore': {
                        inject = inject ?? { operation: 'append', location: '', param: '', lore: true };
                        inject.location = arg.join(' ');
                        inject.lore = true;
                        return;
                    }
                    case 'inject_at': {
                        inject = inject ?? { operation: 'append', location: '', param: '', lore: false };
                        inject.location = arg.join(' ');
                        inject.lore = false;
                        return;
                    }
                    case 'inject_replace': {
                        inject = inject ?? { operation: 'replace', location: '', param: '', lore: false };
                        inject.operation = 'replace';
                        inject.param = arg.join(' ');
                        return;
                    }
                    case 'inject_prepend': {
                        inject = inject ?? { operation: 'prepend', location: '', param: '', lore: false };
                        inject.operation = 'prepend';
                        inject.param = arg.join(' ');
                        return;
                    }
                    case 'ignore_on_max_context': priority = -1000; return;
                    case 'additional_keys': searchQueries.push({ keys: arg, negative: false }); return;
                    case 'exclude_keys': searchQueries.push({ keys: arg, negative: true }); return;
                    case 'exclude_keys_all': searchQueries.push({ keys: arg, negative: true, all: true }); return;
                    case 'match_full_word': fullWordMatching = true; return;
                    case 'match_partial_word': fullWordMatching = false; return;
                    case 'is_user_icon': return false;
                    case 'activate': forceState = 'activate'; return;
                    case 'dont_activate': forceState = 'deactivate'; return;
                    case 'disable_ui_prompt': {
                        if (['post_history_instructions', 'system_prompt'].includes(arg[0])) {
                            disabledUIPrompts.push(arg[0]); return;
                        }
                        return false;
                    }
                    case 'probability': {
                        if (Math.random() * 100 > parseInt(arg[0])) activated = false;
                        return;
                    }
                    case 'priority': priority = parseInt(arg[0]); return;
                    case 'unrecursive': itemRecursive = false; return;
                    case 'recursive': itemRecursive = true; return;
                    case 'no_recursive_search': dontSearchWhenRecursive = true; return;
                    default: return false;
                }
            });

            // Search queries
            if (!activated || forceState !== 'none' || fullLore[i].alwaysActive) {
                // skip search
            } else {
                searchQueries.push({ keys: fullLore[i].key.split(','), negative: false });
                if (fullLore[i].secondkey && fullLore[i].selective) {
                    searchQueries.push({ keys: fullLore[i].secondkey.split(','), negative: false });
                }
                for (const query of searchQueries) {
                    const result = searchMatch(currentChat, {
                        keys: query.keys,
                        searchDepth: scanDepth,
                        regex: fullLore[i].useRegex,
                        fullWordMatching,
                        all: query.all,
                        dontSearchWhenRecursive,
                    });
                    if (query.negative) {
                        if (result) { activated = false; break; }
                    } else {
                        if (!result) { activated = false; break; }
                    }
                }
            }

            if (forceState === 'activate') activated = true;
            else if (forceState === 'deactivate') activated = false;

            if (activated) {
                actives.push({
                    depth, pos,
                    prompt: content,
                    role, order,
                    tokens: approxTokens(content),
                    priority,
                    source: fullLore[i].comment || `lorebook ${i}`,
                    inject: inject ?? null,
                });
                activatedIndexes.push(i);

                if (keepActivateAfterMatch) {
                    setCV('__internal_ka_' + (fullLore[i].id ?? pickHashRand(5555, fullLore[i].content).toString()), 'true');
                }
                if (dontActivateAfterMatch) {
                    setCV('__internal_da_' + (fullLore[i].id ?? pickHashRand(5555, fullLore[i].content).toString()), 'true');
                }

                let recursive = recursiveScanning;
                if (itemRecursive !== 'global') recursive = itemRecursive;
                if (recursive) {
                    matching = true;
                    recursivePrompt.push({
                        prompt: content,
                        data: content,
                        source: fullLore[i].comment || `lorebook ${i}`,
                    });
                }
            }
        }
    }

    // ─── Sort, filter by token budget, re-sort by order ───
    const activesSorted = actives.sort((a, b) => b.priority - a.priority);
    let usedTokens = 0;
    const activesFiltered = activesSorted.filter(act => {
        if (usedTokens + act.tokens <= loreToken) {
            usedTokens += act.tokens;
            return true;
        }
        return false;
    });
    let activesResorted = activesFiltered.sort((a, b) => b.order - a.order);

    // ─── Lore injection ───
    const loreInjectionLores = activesResorted.filter(act => act?.inject?.lore);
    activesResorted = activesResorted.filter(act => !act?.inject?.lore);

    for (const lore of loreInjectionLores) {
        const foundLoreIndex = activesResorted.findIndex(l => l.source === lore.inject.location);
        if (foundLoreIndex !== -1) {
            const foundLore = activesResorted[foundLoreIndex];
            switch (lore.inject.operation) {
                case 'append': foundLore.prompt += ' ' + lore.prompt; break;
                case 'prepend': foundLore.prompt = lore.prompt + ' ' + foundLore.prompt; break;
                case 'replace': foundLore.prompt = foundLore.prompt.replace(lore.inject.param, lore.prompt); break;
            }
        }
    }

    return {
        actives: activesResorted.reverse(),
        matchLog,
        disabledUIPrompts,
    };
}

module.exports = { loadLoreBookV3Prompt };
