/**
 * Node-Risu Server-Side Chat Engine
 * 
 * Handles LLM communication directly on the server, bypassing the frontend proxy loop.
 * Streams responses back to the client via SSE (Server-Sent Events).
 * 
 * KEY DESIGN: The LLM request runs as a background job on the server.
 * If the frontend disconnects (refresh/close), the LLM request continues,
 * the response is saved to disk, and the frontend can recover it on reconnect.
 * 
 * Flow:
 *   1. POST /api/chat/send → starts background job, returns jobId immediately
 *   2. GET /api/chat/stream/:jobId → SSE stream of chunks (reconnectable)
 *   3. GET /api/chat/job/:jobId → poll job status (for recovery)
 *   4. Background job: fetch LLM → collect response → save to disk → done
 */

const { existsSync, mkdirSync } = require('fs');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { loadDatabaseFromDisk, updateCharacterChat } = require('./serverRisuSave.cjs');

let promptBuilder = null;
try {
    promptBuilder = require('./promptBuilder.cjs');
    console.log('[ChatEngine] promptBuilder.cjs loaded — full pipeline enabled');
} catch (e) {
    console.warn('[ChatEngine] promptBuilder.cjs not found, using MVP builder');
}

const { isServerChatEnabled, getFeatureFlags, setFeatureFlag } = require('./serverFeatureFlags.cjs');

const savePath = path.join(process.cwd(), "save");

// =============================================================================
// Database Access — via serverRisuSave.cjs (RISUSAVE format)
// =============================================================================

async function loadDatabase() {
    try {
        return await loadDatabaseFromDisk();
    } catch (e) {
        console.error('[ChatEngine] loadDatabase failed:', e.message);
        return null;
    }
}

// =============================================================================
// Background Job Tracker
// =============================================================================

/**
 * Active jobs map. Each job represents an in-flight or completed LLM request.
 * Jobs are kept in memory for 10 minutes after completion for recovery.
 * 
 * Job states: 'pending' → 'streaming' → 'saving' → 'done' | 'error'
 */
const activeJobs = new Map();

const JOB_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * @typedef {Object} ChatJob
 * @property {string} id
 * @property {'pending'|'streaming'|'saving'|'done'|'error'} status
 * @property {number} charIndex
 * @property {number} chatPage
 * @property {string} userMessage
 * @property {string} fullText - Accumulated response text
 * @property {string|null} error - Error message if failed
 * @property {number} createdAt
 * @property {number|null} completedAt
 * @property {string} model
 * @property {Set<import('express').Response>} listeners - SSE clients listening to this job
 */

function createJob(charIndex, chatPage, userMessage, model) {
    const job = {
        id: crypto.randomUUID(),
        status: 'pending',
        charIndex,
        chatPage,
        userMessage,
        fullText: '',
        error: null,
        createdAt: Date.now(),
        completedAt: null,
        model: model || 'unknown',
        listeners: new Set(),
    };
    activeJobs.set(job.id, job);
    return job;
}

function cleanupOldJobs() {
    const now = Date.now();
    for (const [id, job] of activeJobs) {
        if (job.completedAt && (now - job.completedAt) > JOB_TTL_MS) {
            activeJobs.delete(id);
        }
    }
}

// Run cleanup every 5 minutes
setInterval(cleanupOldJobs, 5 * 60 * 1000);

/**
 * Broadcast an SSE event to all listeners of a job.
 * Silently removes disconnected listeners.
 */
function broadcastToListeners(job, eventData) {
    const data = typeof eventData === 'string' ? eventData : JSON.stringify(eventData);
    for (const res of job.listeners) {
        try {
            if (!res.destroyed && !res.writableEnded) {
                res.write(`data: ${data}\n\n`);
            } else {
                job.listeners.delete(res);
            }
        } catch (e) {
            job.listeners.delete(res);
        }
    }
}

function endAllListeners(job) {
    for (const res of job.listeners) {
        try {
            if (!res.destroyed && !res.writableEnded) {
                res.write('data: [DONE]\n\n');
                res.end();
            }
        } catch (e) { /* ignore */ }
    }
    job.listeners.clear();
}

// =============================================================================
// LLM Request Builder (MVP fallback)
// =============================================================================

function buildChatRequest(db, charIndex, chatPage, userMessage, overrides = {}) {
    const char = db.characters[charIndex];
    if (!char) throw new Error(`Character not found at index ${charIndex}`);

    const chat = char.chats[chatPage || 0];
    if (!chat) throw new Error(`Chat page ${chatPage} not found`);

    const messages = [];

    // System prompt
    const systemPrompt = [
        db.mainPrompt || '',
        char.systemPrompt || char.desc || '',
        db.globalNote ? `\n${db.globalNote}` : '',
    ].filter(Boolean).join('\n');

    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }

    // Chat history
    for (const msg of chat.message) {
        messages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.data,
        });
    }

    // New user message
    if (userMessage) {
        messages.push({ role: 'user', content: userMessage });
    }

    // Jailbreak 
    if (db.jailbreak && db.jailbreakToggle) {
        messages.push({ role: 'system', content: db.jailbreak });
    }

    const model = overrides.model || db.currentPluginProvider || db.aiModel || 'gpt-3.5-turbo';
    const maxTokens = overrides.maxTokens || db.maxResponse || 500;
    const temperature = typeof overrides.temperature === 'number'
        ? overrides.temperature / 100
        : (db.temperature || 80) / 100;

    return {
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: true,
    };
}

// =============================================================================
// Background LLM Fetch (decoupled from client connection)
// =============================================================================

// =============================================================================
// Multi-format SSE Parser
// =============================================================================

/**
 * Extract delta text from a single SSE JSON chunk.
 * Supports OpenAI, Google Gemini/Vertex AI, and Anthropic Claude.
 * @returns {string} extracted text (empty string if none)
 */
function extractDeltaFromSSE(json) {
    // OpenAI: choices[0].delta.content
    const oaiDelta = json.choices?.[0]?.delta?.content;
    if (oaiDelta) return oaiDelta;

    // Anthropic: content_block_delta
    if (json.type === 'content_block_delta' && json.delta?.text) {
        return json.delta.text;
    }

    // Google Gemini / Vertex AI: candidates[0].content.parts[].text
    const parts = json.candidates?.[0]?.content?.parts;
    if (parts && Array.isArray(parts)) {
        let text = '';
        for (const part of parts) {
            if (part.text && !part.thought) {
                text += part.text;
            }
        }
        if (text) return text;
    }

    return '';
}

/**
 * Read an SSE stream and accumulate text into a job.
 * Works for any format (OpenAI, Gemini, Anthropic).
 */
async function consumeSSEStream(reader, job) {
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            if (!trimmed.startsWith('data: ')) continue;

            try {
                const json = JSON.parse(trimmed.slice(6));
                const delta = extractDeltaFromSSE(json);
                if (delta) {
                    job.fullText += delta;
                    broadcastToListeners(job, { text: delta, full: job.fullText });
                }
            } catch (parseErr) {
                // Non-JSON SSE line, skip
            }
        }
    }
}

// =============================================================================
// Background LLM Fetch (decoupled from client connection)
// =============================================================================

/**
 * Fetch LLM response in the background. This function:
 * - Runs independently of any SSE client connection
 * - Broadcasts chunks to any connected listeners
 * - Saves the response to disk when complete
 * - Continues even if all listeners disconnect
 */
async function runBackgroundLLMFetch(job, apiUrl, apiKey, requestBody) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    job.status = 'streaming';
    console.log(`[ChatEngine] Job ${job.id.substring(0, 8)} started | ${apiUrl.substring(0, 80)} | model: ${job.model}`);

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`LLM API error ${response.status}: ${errorText.substring(0, 500)}`);
        }

        if (!response.body) {
            throw new Error('No response body from LLM');
        }

        await consumeSSEStream(response.body.getReader(), job);
    } catch (error) {
        console.error(`[ChatEngine] Job ${job.id.substring(0, 8)} LLM error:`, error.message);
        job.status = 'error';
        job.error = error.message;
        job.completedAt = Date.now();
        broadcastToListeners(job, { error: true, message: error.message });
        endAllListeners(job);
        return;
    }

    await saveJobResponse(job);
}

/**
 * Fetch LLM response using a pre-built request (URL + headers + body).
 * Used by POST /api/chat/send-raw — the frontend builds the complete request
 * (including auth headers for Vertex AI, etc.) and hands it off.
 */
async function runRawLLMFetch(job, url, headers, body) {
    job.status = 'streaming';
    job.isRaw = true; // Frontend manages chat data — skip DB write in saveJobResponse
    console.log(`[ChatEngine] Job ${job.id.substring(0, 8)} RAW started | ${url.substring(0, 80)} | model: ${job.model}`);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: typeof body === 'string' ? body : JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`LLM API error ${response.status}: ${errorText.substring(0, 500)}`);
        }

        if (!response.body) {
            throw new Error('No response body from LLM');
        }

        // Detect SSE (streaming) vs JSON (non-streaming) by Content-Type
        const contentType = response.headers.get('content-type') || '';
        const isSSE = contentType.includes('text/event-stream') ||
            contentType.includes('stream') ||
            url.includes('alt=sse') ||
            url.includes(':streamGenerateContent');

        if (isSSE) {
            await consumeSSEStream(response.body.getReader(), job);
        } else {
            // Non-streaming: read full JSON response
            const rawText = await response.text();
            let jsonData;
            try {
                jsonData = JSON.parse(rawText);
            } catch {
                jsonData = rawText;
            }

            // Store raw response for frontend post-processing
            job.rawResponse = jsonData;

            // Extract text content for the DB save
            const text = extractTextFromGeminiJSON(jsonData);
            job.fullText = text;

            console.log(`[ChatEngine] Job ${job.id.substring(0, 8)} non-streaming response: ${text.length} chars`);
            broadcastToListeners(job, { text: text, full: text });
        }
    } catch (error) {
        console.error(`[ChatEngine] Job ${job.id.substring(0, 8)} RAW error:`, error.message);
        job.status = 'error';
        job.error = error.message;
        job.completedAt = Date.now();
        broadcastToListeners(job, { error: true, message: error.message });
        endAllListeners(job);
        return;
    }

    await saveJobResponse(job);
}

/**
 * Extract text content from a non-streaming LLM JSON response.
 * Supports Gemini, OpenAI, and Anthropic formats.
 */
function extractTextFromGeminiJSON(data) {
    let text = '';

    // Handle array response (some Gemini responses are arrays)
    const items = Array.isArray(data) ? data : [data];

    for (const item of items) {
        // Gemini: candidates[0].content.parts[].text
        const parts = item?.candidates?.[0]?.content?.parts;
        if (parts && Array.isArray(parts)) {
            for (const part of parts) {
                if (part.text && !part.thought) {
                    text += part.text;
                }
            }
            continue;
        }

        // OpenAI: choices[0].message.content
        const oaiContent = item?.choices?.[0]?.message?.content;
        if (oaiContent) {
            text += oaiContent;
            continue;
        }

        // Anthropic: content[0].text
        if (item?.content && Array.isArray(item.content)) {
            for (const block of item.content) {
                if (block.type === 'text' && block.text) {
                    text += block.text;
                }
            }
        }
    }

    return text;
}

/**
 * Save the completed LLM response to the RISUSAVE database.
 * For raw jobs (isRaw=true), skip DB write — the frontend manages chat data.
 * The fullText is still available in the job for recovery via initServerChatRecovery().
 */
async function saveJobResponse(job) {
    job.status = 'saving';
    broadcastToListeners(job, { saving: true, full: job.fullText });

    // Raw jobs: frontend manages chat data, server only captures the response.
    // On page refresh, initServerChatRecovery() injects the response into the store.
    if (!job.isRaw) {
        try {
            const freshDb = await loadDatabase();
            if (freshDb) {
                const chat = freshDb.characters[job.charIndex]?.chats[job.chatPage];
                if (chat) {
                    if (job.userMessage) {
                        chat.message.push({
                            role: 'user',
                            data: job.userMessage,
                            time: Date.now(),
                            chatId: crypto.randomUUID(),
                        });
                    }

                    chat.message.push({
                        role: 'char',
                        data: job.fullText,
                        saying: freshDb.characters[job.charIndex].chaId,
                        time: Date.now(),
                        chatId: crypto.randomUUID(),
                        generationInfo: {
                            model: job.model,
                            generationId: crypto.randomUUID(),
                        }
                    });

                    await updateCharacterChat(job.charIndex, chat, job.chatPage);
                    console.log(`[ChatEngine] Job ${job.id.substring(0, 8)} saved to DB: ${job.fullText.length} chars`);

                    // Auto-archive if message count exceeds threshold
                    try {
                        const { checkAndArchive } = require('./chatArchive.cjs');
                        const chaId = freshDb.characters[job.charIndex]?.chaId;
                        if (chaId) {
                            await checkAndArchive(chaId, job.chatPage, chat.message.length);
                        }
                    } catch (archiveErr) {
                        // Archive module not available or error — non-fatal
                    }
                }
            }
        } catch (saveErr) {
            console.error(`[ChatEngine] Job ${job.id.substring(0, 8)} save failed:`, saveErr.message);
        }
    } else {
        console.log(`[ChatEngine] Job ${job.id.substring(0, 8)} raw — skip DB write (${job.fullText.length} chars captured)`);
    }

    // ─── Complete ───
    job.status = 'done';
    job.completedAt = Date.now();
    broadcastToListeners(job, { done: true, full: job.fullText });
    endAllListeners(job);
    console.log(`[ChatEngine] Job ${job.id.substring(0, 8)} complete | ${job.fullText.length} chars | ${Date.now() - job.createdAt}ms`);
}

// =============================================================================
// API URL Resolution
// =============================================================================

function resolveApiUrl(db) {
    if (db.forceReplaceUrl) return db.forceReplaceUrl;
    if (db.reverseProxyOobaURL) return db.reverseProxyOobaURL;
    return 'https://api.openai.com/v1/chat/completions';
}

function resolveApiKey(db) {
    return db.openAIKey || db.proxyKey || '';
}

// =============================================================================
// Register Express Routes
// =============================================================================

/**
 * Register chat engine routes on the Express app.
 * @param {import('express').Express} app
 * @param {string} serverPassword - The server password for auth
 */
function registerChatRoutes(app, serverPassword) {

    // ─── Auth middleware helper ───
    function checkAuth(req, res) {
        const authHeader = req.headers['risu-auth'];
        if (!authHeader || authHeader.trim() !== serverPassword.trim()) {
            res.status(401).json({ error: 'Password Incorrect' });
            return false;
        }
        return true;
    }

    /**
     * POST /api/chat/send
     * 
     * Starts a background LLM job and returns the jobId.
     * The frontend can then connect to /api/chat/stream/:jobId for SSE,
     * or poll /api/chat/job/:jobId for status.
     * 
     * Body: {
     *   charIndex: number, chatPage: number, userMessage: string,
     *   apiUrl?: string, apiKey?: string, model?: string,
     *   maxTokens?: number, temperature?: number
     * }
     * 
     * Response: { jobId: string }
     */
    app.post('/api/chat/send', async (req, res) => {
        if (!checkAuth(req, res)) return;

        if (!isServerChatEnabled()) {
            res.status(503).json({
                error: 'Server chat is not enabled. Set useServerChat=true via /api/flags or server-config.json'
            });
            return;
        }

        try {
            const { charIndex, chatPage, userMessage, apiUrl, apiKey, model, maxTokens, temperature } = req.body;

            if (charIndex === undefined || chatPage === undefined) {
                res.status(400).json({ error: 'charIndex and chatPage are required' });
                return;
            }

            // Load database
            const db = await loadDatabase();
            if (!db) {
                res.status(500).json({ error: 'Failed to load database' });
                return;
            }

            // Build request
            let requestBody;
            if (promptBuilder) {
                try {
                    requestBody = await promptBuilder.buildFullPrompt({
                        db, charIndex, chatPage,
                        userMessage: userMessage || '',
                        overrides: { model, maxTokens, temperature },
                    });
                } catch (pipelineErr) {
                    console.error('[ChatEngine] Pipeline failed, fallback to MVP:', pipelineErr.message);
                    requestBody = buildChatRequest(db, charIndex, chatPage, userMessage || '', {
                        model, maxTokens, temperature,
                    });
                }
            } else {
                requestBody = buildChatRequest(db, charIndex, chatPage, userMessage || '', {
                    model, maxTokens, temperature,
                });
            }

            // Resolve API
            const resolvedUrl = apiUrl || resolveApiUrl(db);
            const resolvedKey = apiKey || resolveApiKey(db);

            // Create background job
            const job = createJob(charIndex, chatPage || 0, userMessage || '', requestBody.model);

            // Start background fetch (fire-and-forget — runs independently of this response)
            runBackgroundLLMFetch(job, resolvedUrl, resolvedKey, requestBody);

            // Return job ID immediately
            res.json({ jobId: job.id });

        } catch (error) {
            console.error('[ChatEngine] Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/chat/send-raw
     * 
     * Accept a pre-built LLM request from the frontend.
     * The frontend has already resolved auth (Vertex AI JWT, etc.),
     * built the request body, and determined the URL.
     * The server fires the request as a background job.
     * 
     * Body: {
     *   charIndex: number, chatPage: number, userMessage?: string,
     *   request: { url: string, headers: object, body: object|string },
     *   model?: string
     * }
     * 
     * Response: { jobId: string }
     */
    app.post('/api/chat/send-raw', async (req, res) => {
        if (!checkAuth(req, res)) return;

        try {
            const { charIndex, chatPage, userMessage, request, model } = req.body;

            if (charIndex === undefined || chatPage === undefined) {
                res.status(400).json({ error: 'charIndex and chatPage are required' });
                return;
            }
            if (!request?.url) {
                res.status(400).json({ error: 'request.url is required' });
                return;
            }

            // Create background job
            const job = createJob(charIndex, chatPage || 0, userMessage || '', model || 'unknown');

            // Start background fetch (fire-and-forget)
            runRawLLMFetch(job, request.url, request.headers || {}, request.body);

            // Return job ID immediately
            res.json({ jobId: job.id });

        } catch (error) {
            console.error('[ChatEngine] send-raw error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * GET /api/chat/stream/:jobId
     * 
     * SSE endpoint — attach to a running job and receive chunks in real-time.
     * If the job is already complete, sends the full response immediately.
     * Reconnectable: if client disconnects and reconnects, picks up from current state.
     */
    app.get('/api/chat/stream/:jobId', (req, res) => {
        if (!checkAuth(req, res)) return;

        const job = activeJobs.get(req.params.jobId);
        if (!job) {
            res.status(404).json({ error: 'Job not found or expired' });
            return;
        }

        // SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        // If job already has accumulated text, send it immediately
        if (job.fullText) {
            res.write(`data: ${JSON.stringify({ text: job.fullText, full: job.fullText, catchup: true })}\n\n`);
        }

        // If job is already done, send completion and close
        if (job.status === 'done') {
            res.write(`data: ${JSON.stringify({ done: true, full: job.fullText })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        if (job.status === 'error') {
            res.write(`data: ${JSON.stringify({ error: true, message: job.error })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        // Subscribe to live updates
        job.listeners.add(res);

        // Clean up on client disconnect
        req.on('close', () => {
            job.listeners.delete(res);
            console.log(`[ChatEngine] SSE client disconnected from job ${job.id.substring(0, 8)} (${job.listeners.size} remaining)`);
        });
    });

    /**
     * GET /api/chat/job/:jobId
     * 
     * Poll endpoint — check job status without SSE.
     * Used for recovery after page refresh.
     */
    app.get('/api/chat/job/:jobId', (req, res) => {
        if (!checkAuth(req, res)) return;

        const job = activeJobs.get(req.params.jobId);
        if (!job) {
            res.status(404).json({ error: 'Job not found or expired' });
            return;
        }

        res.json({
            id: job.id,
            status: job.status,
            charIndex: job.charIndex,
            chatPage: job.chatPage,
            fullText: job.fullText,
            rawResponse: job.rawResponse || null,
            error: job.error,
            model: job.model,
            createdAt: job.createdAt,
            completedAt: job.completedAt,
            elapsed: Date.now() - job.createdAt,
        });
    });

    /**
     * GET /api/chat/jobs
     * 
     * List all active/recent jobs (for recovery UI).
     */
    app.get('/api/chat/jobs', (req, res) => {
        if (!checkAuth(req, res)) return;

        const jobs = [];
        for (const [id, job] of activeJobs) {
            jobs.push({
                id: job.id,
                status: job.status,
                charIndex: job.charIndex,
                chatPage: job.chatPage,
                model: job.model,
                textLength: job.fullText.length,
                createdAt: job.createdAt,
                completedAt: job.completedAt,
            });
        }
        res.json({ jobs });
    });

    /**
     * GET /api/chat/status
     */
    app.get('/api/chat/status', async (req, res) => {
        if (!checkAuth(req, res)) return;
        const flags = getFeatureFlags();
        res.json({
            serverChat: flags.useServerChat,
            version: '0.3.0',
            capabilities: [
                'background-jobs',
                'sse-streaming',
                'reconnectable',
                'chat-save-risusave',
                'feature-flags',
            ],
            featureFlags: flags,
            pipeline: promptBuilder ? 'full' : 'mvp',
            activeJobs: activeJobs.size,
        });
    });

    // Feature flag endpoints
    app.get('/api/flags', (req, res) => {
        if (!checkAuth(req, res)) return;
        res.json(getFeatureFlags());
    });

    app.post('/api/flags', (req, res) => {
        if (!checkAuth(req, res)) return;
        const { name, value } = req.body;
        if (!name) {
            res.status(400).json({ error: 'name is required' });
            return;
        }
        const flags = setFeatureFlag(name, value);
        res.json(flags);
    });

    console.log('[Server] Chat engine routes registered (v0.3.0 — background jobs)');
}

module.exports = { registerChatRoutes, loadDatabase, buildChatRequest };
