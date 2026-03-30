/**
 * promptBuilder.cjs — Server-side prompt assembly pipeline
 * 
 * Integrates all ported modules:
 *   - serverParser.cjs (risuChatParser)
 *   - serverCBS.cjs (CBS engine)
 *   - serverLorebook.cjs (lorebook engine)
 *   - serverScripts.cjs (regex engine)
 *
 * Replicates the core prompt assembly from sendChat() in index.svelte.ts,
 * using the promptTemplate to order message blocks.
 */
'use strict';

const { risuChatParser } = require('./serverParser.cjs');
const { loadLoreBookV3Prompt } = require('./serverLorebook.cjs');
const { processScriptFull } = require('./serverScripts.cjs');

// Optional: Lua runtime (available when wasmoon is installed)
let luaRuntime = null;
try {
    luaRuntime = require('./serverLuaRuntime.cjs');
    if (luaRuntime.isLuaAvailable()) {
        console.log('[PromptBuilder] Lua runtime available');
    } else {
        console.log('[PromptBuilder] Lua runtime loaded but wasmoon not installed');
    }
} catch (e) {
    console.log('[PromptBuilder] Lua runtime not available');
}

// ─── Default prompt template (when db.promptTemplate is not set) ───
const DEFAULT_TEMPLATE = [
    { type: 'plain', text: '', role: 'system', type2: 'main' },
    { type: 'description' },
    { type: 'persona' },
    { type: 'lorebook' },
    { type: 'chat' },
    { type: 'authornote' },
    { type: 'plain', text: '', role: 'system', type2: 'globalNote' },
    { type: 'plain', text: '', role: 'system', type2: 'jailbreak' },
    { type: 'postEverything' },
];

/**
 * Approximate token count (chars / 4)
 */
function approxTokens(text) {
    return Math.ceil((text || '').length / 4);
}

/**
 * Parse CBS in text using the server parser
 */
function parse(text, db, charIndex, opts = {}) {
    if (!text) return '';
    return risuChatParser(text, {
        db, charIndex,
        chatID: opts.chatID ?? -1,
        runVar: true,
        cbsConditions: opts.cbsConditions ?? {},
        ...opts,
    });
}

/**
 * Build a full prompt from the database, character data, and user message.
 * Returns an OpenAI-compatible messages array plus metadata.
 *
 * @param {object} opts
 * @param {object} opts.db - Full database object
 * @param {number} opts.charIndex - Character index in db.characters[]
 * @param {number} [opts.chatPage] - Chat page (defaults to char.chatPage)
 * @param {string} [opts.userMessage=''] - New user message
 * @param {object} [opts.overrides={}] - Model overrides
 * @returns {Promise<{ messages: Array, model: string, stream: boolean, temperature: number, max_tokens: number, frequency_penalty: number, presence_penalty: number, lorebookLog: object, luaEnabled: boolean }>}
 */
async function buildFullPrompt(opts) {
    const { db, charIndex, overrides = {} } = opts;
    const char = db.characters[charIndex];
    if (!char) throw new Error(`Character at index ${charIndex} not found`);

    const chatPage = opts.chatPage ?? char.chatPage;
    const chat = char.chats[chatPage];
    if (!chat) throw new Error(`Chat page ${chatPage} not found`);

    const userMessage = opts.userMessage || '';
    const cbsConditions = {};

    // ─── CBS-parsed base texts ───
    const charName = parse(char.name, db, charIndex) || 'Bot';
    const userName = parse(db.username, db, charIndex) || 'User';
    const mainPrompt = parse(db.mainPrompt, db, charIndex);
    const jailbreak = db.jailbreakToggle ? parse(db.jailbreak, db, charIndex) : '';
    const globalNote = parse(db.globalNote, db, charIndex);
    const description = parse(char.desc, db, charIndex);
    const personality = parse(char.personality, db, charIndex);
    const scenario = parse(char.scenario, db, charIndex);
    const personaPrompt = parse(db.personaPrompt, db, charIndex);
    const firstMessage = parse(
        chat.fmIndex === -1 ? char.firstMessage : (char.alternateGreetings?.[chat.fmIndex] || char.firstMessage),
        db, charIndex
    );

    // ─── Lorebook ───
    let lorebookResult = { actives: [], matchLog: [], disabledUIPrompts: [] };
    try {
        lorebookResult = loadLoreBookV3Prompt({
            db, charIndex,
            moduleLorebooks: [], // TODO: extract module lorebooks from db if available
        });
    } catch (e) {
        console.error('[PromptBuilder] Lorebook error:', e.message);
    }

    // ─── Prompt Template ───
    const template = JSON.parse(JSON.stringify(
        db.promptTemplate || DEFAULT_TEMPLATE
    ));

    // Ensure postEverything exists
    if (!template.some(c => c.type === 'postEverything')) {
        template.push({ type: 'postEverything' });
    }

    // ─── Build unformatted blocks ───
    const blocks = {
        main: mainPrompt ? [{ role: 'system', content: mainPrompt }] : [],
        description: [],
        personality: [],
        scenario: [],
        persona: personaPrompt ? [{ role: 'system', content: personaPrompt }] : [],
        lorebook: [],
        chat: [],
        authorNote: globalNote ? [{ role: 'system', content: globalNote }] : [],
        jailbreak: jailbreak ? [{ role: 'system', content: jailbreak }] : [],
        postEverything: [],
    };

    // Description block
    if (description) {
        blocks.description.push({ role: 'system', content: description });
    }
    if (personality) {
        blocks.personality = [{ role: 'system', content: personality }];
    }
    if (scenario) {
        blocks.scenario = [{ role: 'system', content: scenario }];
    }

    // Lorebook entries (non-depth, non-inject)
    for (const lore of lorebookResult.actives) {
        if (lore.pos && (lore.pos === 'depth' || lore.pos === 'reverse_depth')) continue;
        if (lore.inject) continue;
        if (lore.pos && lore.pos.startsWith('pt_')) {
            // Will be placed via template position
            continue;
        }
        blocks.lorebook.push({ role: lore.role || 'system', content: lore.prompt });
    }

    // Chat history
    if (chat.message.length === 0 && firstMessage) {
        blocks.chat.push({ role: 'assistant', content: firstMessage });
    }
    for (const msg of chat.message) {
        if (msg.disabled) continue;
        blocks.chat.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: parse(msg.data, db, charIndex, { chatID: chat.message.indexOf(msg) }),
        });
    }

    // New user message
    if (userMessage) {
        blocks.chat.push({ role: 'user', content: userMessage });
    }

    // ─── Assemble via template ───
    const messages = [];
    for (const card of template) {
        switch (card.type) {
            case 'plain': {
                if (card.type2 === 'main') {
                    messages.push(...blocks.main);
                } else if (card.type2 === 'globalNote') {
                    messages.push(...blocks.authorNote);
                } else if (card.type2 === 'jailbreak') {
                    messages.push(...blocks.jailbreak);
                } else if (card.text) {
                    const parsed = parse(card.text, db, charIndex);
                    if (parsed) {
                        messages.push({ role: card.role || 'system', content: parsed });
                    }
                }
                break;
            }
            case 'description': messages.push(...blocks.description); break;
            case 'personality': messages.push(...blocks.personality); break;
            case 'scenario': messages.push(...blocks.scenario); break;
            case 'persona': messages.push(...blocks.persona); break;
            case 'lorebook': messages.push(...blocks.lorebook); break;
            case 'chat': messages.push(...blocks.chat); break;
            case 'authornote': messages.push(...blocks.authorNote); break;
            case 'postEverything': messages.push(...blocks.postEverything); break;
        }

        // Insert position-based lorebook entries
        if (card.type !== 'chat' && card.type !== 'postEverything') {
            const ptKey = 'pt_' + card.type;
            for (const lore of lorebookResult.actives) {
                if (lore.pos === ptKey) {
                    messages.push({ role: lore.role || 'system', content: lore.prompt });
                }
            }
        }
    }

    // ─── Insert depth-based lorebook entries ───
    for (const lore of lorebookResult.actives) {
        if (lore.pos === 'depth' && lore.depth >= 0) {
            // Insert from the end: depth 0 = after last message, depth 1 = one before last, etc.
            const insertIndex = Math.max(0, messages.length - lore.depth);
            messages.splice(insertIndex, 0, { role: lore.role || 'system', content: lore.prompt });
        }
    }

    // ─── Apply editprocess regex ───
    try {
        for (let i = 0; i < messages.length; i++) {
            const result = processScriptFull({
                db, charIndex, char,
                data: messages[i].content,
                mode: 'editprocess',
                chatID: -1,
                cbsConditions,
                risuChatParser: (t, a) => parse(t, db, charIndex, a),
            });
            messages[i].content = result.data;
        }
    } catch (e) {
        console.error('[PromptBuilder] editprocess error:', e.message);
    }

    // ─── Apply Lua editRequest triggers ───
    const luaEnabled = luaRuntime?.isLuaAvailable() ?? false;
    if (luaEnabled && char.triggerscript?.length > 0) {
        try {
            const chatMessages = messages.map(m => ({ role: m.role, content: m.content }));
            const processed = await luaRuntime.runLuaEditTrigger(char, 'editRequest', chatMessages, {
                db, charIndex,
                risuChatParser: (t) => parse(t, db, charIndex),
            });
            if (Array.isArray(processed)) {
                messages.length = 0;
                messages.push(...processed);
            }
        } catch (e) {
            console.error('[PromptBuilder] Lua editRequest error:', e.message);
        }
    }

    // ─── Inject lorebook entries (inject_at) ───
    for (const lore of lorebookResult.actives) {
        if (lore.inject && !lore.inject.lore) {
            // Find target message by content match or source
            for (let i = 0; i < messages.length; i++) {
                if (messages[i].content.includes(lore.inject.location)) {
                    switch (lore.inject.operation) {
                        case 'append': messages[i].content += '\n' + lore.prompt; break;
                        case 'prepend': messages[i].content = lore.prompt + '\n' + messages[i].content; break;
                        case 'replace': messages[i].content = messages[i].content.replace(lore.inject.param, lore.prompt); break;
                    }
                    break;
                }
            }
        }
    }

    // ─── Filter empty messages ───
    const finalMessages = messages.filter(m => m.content && m.content.trim());

    // ─── Token budget check ───
    const maxContext = db.maxContext || 4096;
    let totalTokens = 0;
    const budgetedMessages = [];
    for (const msg of finalMessages) {
        const tokens = approxTokens(msg.content);
        if (totalTokens + tokens > maxContext) break;
        totalTokens += tokens;
        budgetedMessages.push(msg);
    }

    // ─── Build request ───
    const model = overrides.model || db.aiModel || 'gpt-4o-mini';
    const temperature = (overrides.temperature ?? db.temperature ?? 80) / 100;
    const maxTokens = overrides.maxTokens ?? db.maxResponse ?? 300;

    return {
        messages: budgetedMessages,
        model,
        stream: true,
        temperature,
        max_tokens: maxTokens,
        frequency_penalty: (db.frequencyPenalty ?? 70) / 100,
        presence_penalty: (db.PresensePenalty ?? 70) / 100,
        lorebookLog: {
            activated: lorebookResult.actives.length,
            matchLog: lorebookResult.matchLog,
            disabledUIPrompts: lorebookResult.disabledUIPrompts,
        },
    };
}

module.exports = { buildFullPrompt };
