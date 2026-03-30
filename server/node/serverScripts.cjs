/**
 * serverScripts.cjs — Server-side regex/script processor
 * Ported from: scripts.ts (processScriptFull)
 *
 * Skipped (Phase 3 / display-only):
 *   - Lua edit triggers (wasmoon)
 *   - pluginV2 hooks
 *   - CharEmotion (Svelte store, display-only)
 *   - HypaProcesser (dynamic assets, display-only)
 *   - runTrigger display triggers
 *
 * Kept: core regex engine, flag parsing, @@ actions, order system, caching
 */
'use strict';

const dreg = /{{data}}/g;

/**
 * @param {object} opts
 * @param {object} opts.db - Database object
 * @param {number} opts.charIndex - Selected character index
 * @param {object} opts.char - Character or group chat object
 * @param {string} opts.data - Text to process
 * @param {'editinput'|'editoutput'|'editprocess'|'editdisplay'} opts.mode - Script mode
 * @param {number} [opts.chatID=-1] - Current chat message index
 * @param {object} [opts.cbsConditions={}] - CBS conditions
 * @param {Function} opts.risuChatParser - Server risuChatParser function
 * @param {Function} [opts.getModuleRegexScripts] - Returns module regex scripts
 * @returns {{data: string, emoChanged: boolean}}
 */
function processScriptFull(opts) {
    const {
        db,
        charIndex,
        char,
        mode,
        cbsConditions = {},
        risuChatParser,
        getModuleRegexScripts,
    } = opts;
    let { data } = opts;
    const chatID = opts.chatID ?? -1;
    let emoChanged = false;

    // CBS parse the data first (same as original)
    data = risuChatParser(data, { db, charIndex, chatID, cbsConditions });

    // Collect scripts: preset + character + module
    const presetRegex = db.presetRegex || [];
    const charScripts = char.customscript || [];
    const moduleRegex = getModuleRegexScripts ? getModuleRegexScripts() : [];
    const scripts = presetRegex.concat(charScripts).concat(moduleRegex);

    if (scripts.length === 0) {
        return { data, emoChanged };
    }

    function safeStructuredClone(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    // ─── executeScript (inner function from original) ───
    function executeScript(pscript) {
        const script = pscript.script;
        if (script.in === '') return;
        if (script.type !== mode) return;

        let outScript2 = script.out.replaceAll("$n", "\n");
        let outScript = outScript2.replace(dreg, "$&");
        let flag = 'g';
        if (script.ableFlag) {
            flag = script.flag || 'g';
        }
        if (outScript.startsWith('@@move_top') || outScript.startsWith('@@move_bottom') ||
            pscript.actions.includes('move_top') || pscript.actions.includes('move_bottom')) {
            flag = flag.replace('g', '');
        }
        if (outScript.endsWith('>') && !pscript.actions.includes('no_end_nl')) {
            outScript += '\n';
        }
        // remove unsupported flags
        flag = flag.trim().replace(/[^dgimsuvy]/g, '');
        // remove repeated flags
        flag = flag.split('').filter((v, i, a) => a.indexOf(v) === i).join('');
        if (flag.length === 0) flag = 'u';

        let input = script.in;
        if (pscript.actions.includes('cbs')) {
            input = risuChatParser(input, { db, charIndex, chatID, cbsConditions });
        }

        let reg;
        try { reg = new RegExp(input, flag); }
        catch (e) { return; } // invalid regex, skip

        if (outScript.startsWith('@@') || pscript.actions.length > 0) {
            if (reg.test(data)) {
                if (outScript.startsWith('@@emo ')) {
                    // Skip emotion processing on server (display-only)
                    emoChanged = true;
                }
                else if ((outScript.startsWith('@@inject') || pscript.actions.includes('inject')) && chatID !== -1) {
                    const selchar = db.characters[charIndex];
                    if (selchar) {
                        selchar.chats[selchar.chatPage].message[chatID].data = data;
                    }
                    data = data.replace(reg, "");
                }
                else if (
                    outScript.startsWith('@@move_top') || outScript.startsWith('@@move_bottom') ||
                    pscript.actions.includes('move_top') || pscript.actions.includes('move_bottom')
                ) {
                    const isGlobal = flag.includes('g');
                    const matchAll = isGlobal ? data.matchAll(reg) : [data.match(reg)];
                    data = data.replace(reg, "");
                    for (const matched of matchAll) {
                        if (matched) {
                            const inData = matched[0];
                            let out = outScript.replace('@@move_top ', '').replace('@@move_bottom ', '')
                                .replace(/(?<!\$)\$[0-9]+/g, (v) => {
                                    const index = parseInt(v.substring(1));
                                    if (index < matched.length) return matched[index];
                                    return v;
                                })
                                .replace(/\$\&/g, inData)
                                .replace(/(?<!\$)\$<([^>]+)>/g, (v) => {
                                    const groupName = v.substring(2, v.length - 1);
                                    if (matched.groups && matched.groups[groupName]) return matched.groups[groupName];
                                    return v;
                                });
                            if (outScript.startsWith('@@move_top') || pscript.actions.includes('move_top')) {
                                data = out + '\n' + data;
                            } else {
                                data = data + '\n' + out;
                            }
                        }
                    }
                }
                else {
                    data = risuChatParser(data.replace(reg, outScript), { db, charIndex, chatID, cbsConditions });
                }
            }
            else {
                if ((outScript.startsWith('@@repeat_back') || pscript.actions.includes('repeat_back')) && chatID !== -1) {
                    const v = outScript.split(' ', 2)[1];
                    const selchar = db.characters[charIndex];
                    if (!selchar) return;
                    const chat = selchar.chats[selchar.chatPage];
                    let lastChat = chat.fmIndex === -1 ? selchar.firstMessage : selchar.alternateGreetings[chat.fmIndex];
                    let pointer = chatID - 1;
                    while (pointer >= 0) {
                        if (chat.message[pointer].role === chat.message[chatID].role) {
                            lastChat = chat.message[pointer].data;
                            break;
                        }
                        pointer--;
                    }
                    const r = lastChat.match(reg);
                    if (r && r[0]) {
                        if (!v) { data = data + r[0]; }
                        else {
                            switch (v) {
                                case 'end': data = data + r[0]; break;
                                case 'start': data = r[0] + data; break;
                                case 'end_nl': data = data + "\n" + r[0]; break;
                                case 'start_nl': data = r[0] + "\n" + data; break;
                            }
                        }
                    }
                }
            }
        }
        else {
            data = risuChatParser(data.replace(reg, outScript), { db, charIndex, chatID, cbsConditions });
        }
    }

    // ─── Parse script flags and order ───
    let parsedScripts = [];
    let orderChanged = false;
    for (const script of scripts) {
        if (script.ableFlag && script.flag && script.flag.includes('<')) {
            const rregex = /<(.+?)>/g;
            const scriptData = safeStructuredClone(script);
            let order = 0;
            const actions = [];
            scriptData.flag = scriptData.flag.replace(rregex, (v, p1) => {
                const meta = p1.split(',').map(v => v.trim());
                for (const m of meta) {
                    if (m.startsWith('order ')) {
                        order = parseInt(m.substring(6));
                        orderChanged = true;
                    } else {
                        actions.push(m);
                    }
                }
                return '';
            });
            parsedScripts.push({ script: scriptData, order, actions });
            continue;
        }
        parsedScripts.push({ script, order: 0, actions: [] });
    }

    if (orderChanged) {
        parsedScripts.sort((a, b) => b.order - a.order);
    }

    for (const script of parsedScripts) {
        try {
            executeScript(script);
        } catch (error) {
            // Skip errors in individual scripts
        }
    }

    return { data, emoChanged };
}

module.exports = { processScriptFull };
