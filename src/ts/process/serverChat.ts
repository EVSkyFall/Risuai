/**
 * Server-Side Chat Engine Client (v0.4.1)
 * 
 * Bridges the frontend request pipeline to the server's background job system.
 * When running in Node server mode with useServerChat enabled:
 *   1. Frontend builds the complete LLM request (URL, headers, body)
 *   2. This module POSTs it to /api/chat/send-raw → server creates background job
 *   3. Frontend connects to /api/chat/stream/:jobId for SSE streaming
 *   4. If page refreshes, frontend reconnects to the same job on reload
 *      and injects the completed response into the chat store.
 * 
 * The server owns the LLM connection — it continues even if the frontend disconnects.
 */

import { isNodeServer } from '../platform';
import { DBState, selectedCharID } from '../stores.svelte';
import { forageStorage } from '../globalApi.svelte';
import { activeChatJobs, chatJobKey, chatProcessStage, doingChat } from './index.svelte';
import { get } from 'svelte/store';
import { v4 } from 'uuid';

/**
 * Get the node-risu auth password from localStorage.
 */
function getNodePassword(): string {
    return localStorage.getItem('risuauth') || '';
}

/**
 * Get chat context saved by sendChat() for recovery.
 */
// ─── Multi-Job LocalStorage Helpers ───
// Key: __risu_active_server_jobs
// Value: JSON Map keyed by "charIndex:chatPage" → { jobId, charIndex, chatPage, time }

interface ActiveJobEntry {
    jobId: string;
    charIndex: number;
    chatPage: number;
    time: number;
}

function getActiveJobs(): Record<string, ActiveJobEntry> {
    try {
        const raw = localStorage.getItem('__risu_active_server_jobs');
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function addActiveJob(charIndex: number, chatPage: number, jobId: string) {
    const jobs = getActiveJobs();
    jobs[`${charIndex}:${chatPage}`] = { jobId, charIndex, chatPage, time: Date.now() };
    localStorage.setItem('__risu_active_server_jobs', JSON.stringify(jobs));
}

function removeActiveJob(charIndex: number, chatPage: number) {
    const jobs = getActiveJobs();
    delete jobs[`${charIndex}:${chatPage}`];
    const remaining = JSON.stringify(jobs);
    if (remaining === '{}') {
        localStorage.removeItem('__risu_active_server_jobs');
    } else {
        localStorage.setItem('__risu_active_server_jobs', remaining);
    }
}

function removeActiveJobByJobId(jobId: string) {
    const jobs = getActiveJobs();
    for (const key of Object.keys(jobs)) {
        if (jobs[key].jobId === jobId) {
            delete jobs[key];
            break;
        }
    }
    const remaining = JSON.stringify(jobs);
    if (remaining === '{}') {
        localStorage.removeItem('__risu_active_server_jobs');
    } else {
        localStorage.setItem('__risu_active_server_jobs', remaining);
    }
}

export interface ServerJobInfo {
    jobId: string;
}

/**
 * Send a pre-built LLM request to the server's background job system.
 * Returns the jobId for SSE streaming.
 */
export async function sendRawToServer(
    url: string,
    headers: Record<string, string>,
    body: any,
    model?: string,
    charIndex?: number,
    chatPage?: number
): Promise<ServerJobInfo> {
    const ci = charIndex ?? 0;
    const cp = chatPage ?? 0;

    const res = await fetch('/api/chat/send-raw', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'risu-auth': getNodePassword(),
        },
        body: JSON.stringify({
            charIndex: ci,
            chatPage: cp,
            userMessage: '',
            request: { url, headers, body },
            model: model || 'unknown',
        }),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Server chat send-raw failed: ${err}`);
    }

    const data = await res.json();

    // Save job for multi-job recovery after refresh
    try {
        addActiveJob(ci, cp, data.jobId);
    } catch { /* ignore */ }

    return data;
}

/**
 * Connect to a server job's SSE stream.
 * Returns a ReadableStream<Uint8Array> that emits raw text deltas.
 * 
 * IMPORTANT: The reading loop is fire-and-forget inside start() so that
 * pipeTo() can pull data in real-time as chunks are enqueued. If start()
 * awaited the reading loop, pipeTo() would block until the entire stream
 * finished, causing the streaming to appear as a single dump.
 */
export function connectToJobSSE(jobId: string, signal?: AbortSignal, charIndex?: number, chatPage?: number): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
        start(controller) {
            // Fire-and-forget — don't await, so start() resolves immediately
            (async () => {
                try {
                    const response = await fetch(`/api/chat/stream/${jobId}`, {
                        headers: { 'risu-auth': getNodePassword() },
                        signal,
                    });

                    if (!response.ok) {
                        const err = await response.text();
                        controller.error(new Error(`SSE connect failed: ${err}`));
                        return;
                    }

                    const reader = response.body!.getReader();
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
                            if (!trimmed) continue;
                            if (trimmed === 'data: [DONE]') {
                                try { localStorage.removeItem('__risu_active_job'); } catch { /* */ }
                                controller.close();
                                return;
                            }
                            if (!trimmed.startsWith('data: ')) continue;

                            try {
                                const json = JSON.parse(trimmed.slice(6));

                                if (json.error) {
                                    controller.error(new Error(json.message || 'Server job error'));
                                    return;
                                }

                                if (json.done) {
                                    try { if (charIndex != null && chatPage != null) removeActiveJob(charIndex, chatPage); else removeActiveJobByJobId(jobId); } catch { /* */ }
                                    controller.close();
                                    return;
                                }

                                // Emit FULL accumulated text (not delta).
                                // sendChat() sets message.data = chunk directly,
                                // so each chunk must be the complete text so far.
                                // Server broadcasts { text: delta, full: fullText }.
                                if (json.full) {
                                    controller.enqueue(encoder.encode(json.full));
                                } else if (json.text) {
                                    // Fallback: catchup event only has json.text
                                    controller.enqueue(encoder.encode(json.text));
                                }
                            } catch {
                                // Non-JSON SSE, skip
                            }
                        }
                    }

                    controller.close();
                } catch (err) {
                    if (signal?.aborted) {
                        try { controller.close(); } catch { /* already closed */ }
                    } else {
                        try { controller.error(err); } catch { /* already errored */ }
                    }
                }
            })();
        },
    });
}

// ─── Job polling for recovery ───

interface JobStatus {
    id: string;
    status: 'pending' | 'streaming' | 'saving' | 'done' | 'error';
    fullText: string;
    rawResponse?: any;
    charIndex: number;
    chatPage: number;
    model: string;
    error?: string;
}

/**
 * Fetch current status of a job from the server.
 */
async function fetchJobStatus(jobId: string): Promise<JobStatus | null> {
    try {
        const res = await fetch(`/api/chat/job/${jobId}`, {
            headers: { 'risu-auth': getNodePassword() },
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

/**
 * Poll a job until it reaches 'done' or 'error' status.
 */
async function pollUntilDone(jobId: string, intervalMs = 1500): Promise<JobStatus | null> {
    while (true) {
        const job = await fetchJobStatus(jobId);
        if (!job) return null;
        if (job.status === 'done' || job.status === 'error') {
            return job;
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
}

/**
 * Send a raw request to the server and wait for the raw JSON response.
 * Used for non-streaming requests where the frontend needs the full 
 * response object for post-processing (inlineData, function calls, etc).
 */
export async function waitForJobRawResponse(
    url: string,
    headers: Record<string, string>,
    body: any,
    model?: string,
    signal?: AbortSignal,
    charIndex?: number,
    chatPage?: number,
): Promise<{ ok: boolean; status: number; rawResponse: any; fullText: string; error?: string }> {
    const ci = charIndex ?? 0;
    const cp = chatPage ?? 0;
    const { jobId } = await sendRawToServer(url, headers, body, model, ci, cp);
    console.log(`[ServerChat] Non-streaming job created: ${jobId.substring(0, 8)}`);

    // Poll until done
    const completed = await pollUntilDone(jobId, 500);

    // Clean up this specific job
    try { removeActiveJob(ci, cp); } catch { /* */ }

    if (!completed) {
        return { ok: false, status: 0, rawResponse: null, fullText: '', error: 'Job disappeared' };
    }

    if (completed.status === 'error') {
        return { ok: false, status: 500, rawResponse: null, fullText: '', error: completed.error };
    }

    return {
        ok: true,
        status: 200,
        rawResponse: completed.rawResponse,
        fullText: completed.fullText,
    };
}

/**
 * Inject a completed job's response into the frontend chat store.
 * 
 * Handles two scenarios:
 * - Last message is a char block (empty or partial from interrupted streaming) → REPLACE it
 * - No matching char block → PUSH a new one
 * 
 * NOTE: We do NOT call saveDb() here to avoid BroadcastChannel conflicts.
 * The in-memory mutation will be persisted by the next auto-save cycle.
 */
async function injectRecoveredResponse(job: JobStatus): Promise<boolean> {
    if (!job.fullText || job.status !== 'done') return false;

    const db = DBState.db;
    if (!db?.characters) return false;

    const char = db.characters[job.charIndex];
    if (!char?.chats?.[job.chatPage]) {
        console.warn(`[ServerChat] Cannot inject: char ${job.charIndex} chatPage ${job.chatPage} not found`);
        return false;
    }

    const chat = char.chats[job.chatPage];
    const messages = chat.message;

    // Idempotency guard — skip if the response is already present
    if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role === 'char' && lastMsg.data === job.fullText) {
            console.log('[ServerChat] Response already present in chat, skipping injection');
            return false;
        }
    }

    // Option A fix: Check if the last message is a char block from the interrupted
    // streaming (empty OR partial text). sendChat() pushes { role: 'char', data: "" }
    // before streaming starts, which persists across refresh via auto-save.
    // We REPLACE it instead of pushing a duplicate.
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    const isLastCharBlock = lastMsg && lastMsg.role === 'char';

    const newMsg = {
        role: 'char' as const,
        data: job.fullText,
        saying: char.chaId || char.name,
        time: Date.now(),
        chatId: v4(),
        generationInfo: {
            model: job.model,
            generationId: v4(),
        }
    };

    if (isLastCharBlock) {
        // Replace the incomplete block left by sendChat() (empty or partial)
        messages[messages.length - 1] = { ...messages[messages.length - 1], ...newMsg };
        console.log(`[ServerChat] Replaced incomplete block with recovered response: ${job.fullText.length} chars`);
    } else {
        messages.push(newMsg);
        console.log(`[ServerChat] Pushed recovered response: ${job.fullText.length} chars into char[${job.charIndex}].chats[${job.chatPage}]`);
    }

    return true;
}

/**
 * Get the messages array and the index of the last char block for recovery.
 * Returns the messages array and the target message index, creating a new
 * char block if none exists.
 */
function getRecoveryTarget(job: JobStatus): { messages: any[]; msgIndex: number } | null {
    const db = DBState.db;
    if (!db?.characters) return null;

    const char = db.characters[job.charIndex];
    if (!char?.chats?.[job.chatPage]) return null;

    const messages = char.chats[job.chatPage].message;

    // Find or create the target char block
    const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    if (lastMsg && lastMsg.role === 'char') {
        // Reuse existing block (the one created by sendChat before refresh)
        return { messages, msgIndex: messages.length - 1 };
    }

    // No char block — create one
    messages.push({
        role: 'char',
        data: '',
        saying: char.chaId || char.name,
        time: Date.now(),
        chatId: v4(),
        generationInfo: { model: job.model, generationId: v4() }
    });
    return { messages, msgIndex: messages.length - 1 };
}

/**
 * Initialize server chat recovery on page load.
 * 
 * Supports PARALLEL multi-job recovery:
 * 1. Read all active jobs from __risu_active_server_jobs (Map keyed by charIndex:chatPage)
 * 2. For each job: fetch status → done: inject | streaming: reconnect SSE | error: clean up
 * 3. Show loading bar via doingChat while any job is active
 * 4. Navigate to the first recovered character
 * 
 * Returns true if any chat session was restored.
 * Returns false if no recovery happened.
 */
export async function initServerChatRecovery(): Promise<boolean> {
    if (!isNodeServer) return false;

    // ── Also migrate legacy single-key format ──
    const legacyJob = localStorage.getItem('__risu_active_job');
    if (legacyJob) {
        const ctx = (() => { try { const r = localStorage.getItem('__risu_streaming_context'); return r ? JSON.parse(r) : null; } catch { return null; } })();
        if (ctx) {
            addActiveJob(ctx.charIndex, ctx.chatPage, legacyJob);
        }
        localStorage.removeItem('__risu_active_job');
        localStorage.removeItem('__risu_streaming_context');
    }

    // ── Read all active jobs ──
    const activeJobs = getActiveJobs();
    const entries = Object.entries(activeJobs);

    // ── Check for plugin stream recovery (via /proxy2 TEE capture) ──
    const pluginStreamRaw = localStorage.getItem('__risu_active_plugin_stream');
    if (pluginStreamRaw) {
        try {
            const pluginCtx = JSON.parse(pluginStreamRaw);
            const { charIndex, chatPage, msgIndex, time: streamTime } = pluginCtx;

            // Skip if too old (> 10 minutes)
            if (Date.now() - streamTime > 10 * 60 * 1000) {
                localStorage.removeItem('__risu_active_plugin_stream');
            } else {
                const authHeaders: Record<string, string> = { 'risu-auth': getNodePassword() };

                // Show loading bar while polling
                doingChat.set(true);
                chatProcessStage.set(3);
                console.log('[ServerChat] Plugin recovery: polling for TEE capture...');

                // Poll for recovery data — server may still be reading LLM stream
                const POLL_INTERVAL_MS = 3000;
                const MAX_POLL_TIME_MS = 2 * 60 * 1000; // 2 minutes max
                const pollStart = Date.now();
                let recovered = false;

                while (Date.now() - pollStart < MAX_POLL_TIME_MS) {
                    // Check if server is still actively streaming
                    try {
                        const statusRes = await fetch('/api/chat/streaming-status', { headers: authHeaders });
                        const statusData = await statusRes.json();
                        if (statusData.active) {
                            console.log(`[ServerChat] Server still streaming (${statusData.chunksReceived} chunks) — waiting...`);
                            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                            continue;
                        }
                    } catch { /* streaming-status endpoint may not exist — continue */ }

                    // Try to fetch recovery data
                    const recoveryRes = await fetch('/api/chat/recovery', { headers: authHeaders });
                    const recoveryData = await recoveryRes.json();

                    if (recoveryData.recovery && recoveryData.recovery.text) {
                        // Inject recovered text into the correct message
                        const db = DBState.db;
                        let char = db?.characters?.[charIndex];
                        if (char && char.chats?.[chatPage]) {
                            let chat = char.chats[chatPage];

                            // If message slot is missing, try loading persisted
                            // character data from forageStorage (saved during streaming)
                            if (!chat.message?.[msgIndex]) {
                                try {
                                    const persisted = await forageStorage.getItem(
                                        `remotes/${char.chaId}.local.bin`
                                    ) as Uint8Array;
                                    if (persisted) {
                                        const restored = JSON.parse(
                                            new TextDecoder().decode(persisted)
                                        );
                                        if (restored.chats?.[chatPage]?.message?.[msgIndex]) {
                                            // Replace in-memory character with
                                            // persisted version (has the message slot)
                                            db.characters[charIndex] = restored;
                                            char = restored;
                                            chat = restored.chats[chatPage];
                                            console.log('[ServerChat] Restored char from persisted data');
                                        }
                                    }
                                } catch (e) {
                                    console.warn('[ServerChat] Failed to load persisted char:', e);
                                }
                            }

                            // If still missing, create a placeholder message
                            if (!chat.message?.[msgIndex]) {
                                while (chat.message.length <= msgIndex) {
                                    chat.message.push({
                                        role: 'char',
                                        data: '',
                                        time: Date.now(),
                                    } as any);
                                }
                                console.log('[ServerChat] Created placeholder message at index', msgIndex);
                            }

                            if (chat.message?.[msgIndex]) {
                                chat.message[msgIndex].data = recoveryData.recovery.text;
                                chat.isStreaming = false;
                                console.log('[ServerChat] Plugin stream recovered:', recoveryData.recovery.text.length, 'chars');

                                // Delete recovery file
                                await fetch('/api/chat/recovery', { method: 'DELETE', headers: authHeaders });
                                localStorage.removeItem('__risu_active_plugin_stream');

                                // Navigate to recovered character
                                char.chatPage = chatPage;
                                selectedCharID.set(charIndex);
                                doingChat.set(false);
                                chatProcessStage.set(0);
                                return true;
                            }
                        }
                        // Recovery data exists but character/chat doesn't — give up
                        recovered = false;
                        break;
                    }

                    // No recovery data yet — wait and retry
                    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                }

                // Cleanup on timeout or failure — try plugin text fallback
                if (!recovered) {
                    const fallbackText = localStorage.getItem('__risu_plugin_text_fallback');
                    if (fallbackText && fallbackText.length > 0) {
                        console.log('[ServerChat] Using plugin text fallback:', fallbackText.length, 'chars');
                        const db = DBState.db;
                        let char = db?.characters?.[charIndex];
                        if (char && char.chats?.[chatPage]) {
                            let chat = char.chats[chatPage];
                            if (chat.message?.[msgIndex]) {
                                chat.message[msgIndex].data = fallbackText;
                                chat.isStreaming = false;
                                localStorage.removeItem('__risu_plugin_text_fallback');
                                localStorage.removeItem('__risu_active_plugin_stream');
                                await fetch('/api/chat/recovery', { method: 'DELETE', headers: authHeaders }).catch(() => { });
                                char.chatPage = chatPage;
                                selectedCharID.set(charIndex);
                                doingChat.set(false);
                                chatProcessStage.set(0);
                                return true;
                            }
                        }
                    }
                    console.warn('[ServerChat] Plugin recovery timed out or message slot missing');
                    localStorage.removeItem('__risu_active_plugin_stream');
                    localStorage.removeItem('__risu_plugin_text_fallback');
                }
                doingChat.set(false);
                chatProcessStage.set(0);
            }
        } catch (e) {
            console.warn('[ServerChat] Plugin recovery failed:', e);
            localStorage.removeItem('__risu_active_plugin_stream');
            doingChat.set(false);
            chatProcessStage.set(0);
        }
    }

    if (entries.length === 0) return false;

    console.log(`[ServerChat] Found ${entries.length} active job(s) for recovery`);

    // ── Show loading bar (will be cleared when all jobs finish) ──
    doingChat.set(true);
    chatProcessStage.set(3);

    let anyRecovered = false;
    let firstCharIndex: number | null = null;
    let firstChatPage: number | null = null;

    // Helper: register a recovery job in activeChatJobs so UI shows loading bar
    function registerRecoveryJob(charIndex: number, chatPage: number): string {
        const key = chatJobKey(charIndex, chatPage);
        activeChatJobs.update(m => {
            const next = new Map(m);
            next.set(key, { charId: charIndex, chatPage, abortController: new AbortController(), startedAt: Date.now() });
            return next;
        });
        return key;
    }
    function unregisterRecoveryJob(key: string) {
        activeChatJobs.update(m => {
            const next = new Map(m);
            next.delete(key);
            return next;
        });
    }

    // ── Recover each job in parallel ──
    const recoveryPromises = entries.map(async ([key, entry]) => {
        const { jobId, charIndex, chatPage } = entry;
        const logPrefix = `[ServerChat][${charIndex}:${chatPage}]`;

        try {
            // Fetch job status from server
            const job = await fetchJobStatus(jobId);
            if (!job) {
                console.warn(`${logPrefix} Job ${jobId.substring(0, 8)} not found — cleaning up`);
                removeActiveJob(charIndex, chatPage);
                return;
            }

            // Validate target exists in DB
            const db = DBState.db;
            const char = db?.characters?.[charIndex];
            if (!char || !char.chats?.[chatPage]) {
                console.warn(`${logPrefix} Target not found — cleaning up`);
                removeActiveJob(charIndex, chatPage);
                return;
            }

            // Register in activeChatJobs so UI shows loading bar
            const jobKey = registerRecoveryJob(charIndex, chatPage);

            // Restore chatPage on the character
            char.chatPage = chatPage;

            // Track first recovered char for navigation
            if (firstCharIndex === null) {
                firstCharIndex = charIndex;
                firstChatPage = chatPage;
            }

            if (job.status === 'done') {
                console.log(`${logPrefix} Job done (${job.fullText?.length || 0} chars) — injecting`);
                await injectRecoveredResponse(job);
                char.chats[chatPage].isStreaming = false;
                removeActiveJob(charIndex, chatPage);
                unregisterRecoveryJob(jobKey);
                anyRecovered = true;
                return;
            }

            if (job.status === 'error') {
                console.error(`${logPrefix} Job errored: ${job.error}`);
                removeActiveJob(charIndex, chatPage);
                unregisterRecoveryJob(jobKey);
                anyRecovered = true; // Keep on chat screen
                return;
            }

            // ── Still streaming/pending — reconnect to SSE ──
            console.log(`${logPrefix} Job still ${job.status} — reconnecting SSE`);
            anyRecovered = true;

            const recoveryTarget = getRecoveryTarget(job);
            if (!recoveryTarget) {
                // Fall back to polling
                const completed = await pollUntilDone(jobId);
                if (completed?.status === 'done') {
                    await injectRecoveredResponse(completed);
                }
                removeActiveJob(charIndex, chatPage);
                unregisterRecoveryJob(jobKey);
                return;
            }

            char.chats[chatPage].isStreaming = true;

            // Reconnect SSE — read chunks into the specific message block
            const sseStream = connectToJobSSE(jobId, undefined, charIndex, chatPage);
            const reader = sseStream.getReader();
            const decoder = new TextDecoder();

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const text = decoder.decode(value, { stream: true });
                    if (text) {
                        recoveryTarget.messages[recoveryTarget.msgIndex].data = text;
                    }
                }
            } catch (err) {
                console.warn(`${logPrefix} SSE ended:`, err);
            }

            // Final fallback — fetch definitive text
            const finalJob = await fetchJobStatus(jobId);
            if (finalJob?.status === 'done' && finalJob.fullText) {
                recoveryTarget.messages[recoveryTarget.msgIndex].data = finalJob.fullText;
                console.log(`${logPrefix} Recovery streaming complete: ${finalJob.fullText.length} chars`);
            }

            char.chats[chatPage].isStreaming = false;
            removeActiveJob(charIndex, chatPage);
            unregisterRecoveryJob(jobKey);
        } catch (err) {
            console.error(`[ServerChat] Recovery failed for ${key}:`, err);
            removeActiveJob(entry.charIndex, entry.chatPage);
            unregisterRecoveryJob(chatJobKey(entry.charIndex, entry.chatPage));
        }
    });

    // Wait for all recoveries to settle
    await Promise.allSettled(recoveryPromises);

    // ── Navigate to first recovered character ──
    if (firstCharIndex !== null) {
        const db = DBState.db;
        const char = db?.characters?.[firstCharIndex];
        if (char && firstChatPage !== null) {
            char.chatPage = firstChatPage;
        }
        selectedCharID.set(firstCharIndex);
    }

    // ── Clean up loading state ──
    doingChat.set(false);
    chatProcessStage.set(0);

    return anyRecovered;
}

