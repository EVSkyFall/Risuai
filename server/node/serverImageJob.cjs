/**
 * serverImageJob.cjs
 * 
 * Async job queue for server-side image generation.
 * Frontend submits a fetch job → server runs it in background → frontend polls for result.
 */

const { v4: uuidv4 } = require('uuid');

// In-memory job store: jobId → { status, result, error, createdAt }
const jobs = new Map();

// Auto-expire completed jobs after 5 minutes
const JOB_EXPIRY_MS = 5 * 60 * 1000;

function cleanExpiredJobs() {
    const now = Date.now();
    for (const [id, job] of jobs.entries()) {
        if (job.status !== 'pending' && (now - job.completedAt) > JOB_EXPIRY_MS) {
            jobs.delete(id);
        }
    }
}

// Run cleanup every 60 seconds
setInterval(cleanExpiredJobs, 60_000);

/**
 * Register job API routes on the Express app.
 * @param {object} app - Express app
 * @param {string} password - Server password for auth
 */
function registerImageJobRoutes(app, password) {

    function checkAuth(req) {
        if (password === '') return true;
        return req.headers['risu-auth']?.trim() === password?.trim();
    }

    // Submit a new async fetch job
    app.post('/api/job/submit', async (req, res) => {
        if (!checkAuth(req)) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const { url, method, headers, body, rawResponse } = req.body;
        if (!url) {
            return res.status(400).json({ error: 'url is required' });
        }

        const jobId = uuidv4();
        jobs.set(jobId, {
            status: 'pending',
            result: null,
            error: null,
            createdAt: Date.now(),
            completedAt: null,
        });

        // Return job ID immediately
        res.json({ jobId });

        // Run the fetch in background
        runJobInBackground(jobId, { url, method, headers, body, rawResponse });
    });

    // Check job status
    app.get('/api/job/status', (req, res) => {
        if (!checkAuth(req)) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const { id } = req.query;
        if (!id || !jobs.has(id)) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const job = jobs.get(id);
        res.json({
            status: job.status,
            result: job.result,
            error: job.error,
        });
    });

    // Clear a completed job
    app.delete('/api/job/clear', (req, res) => {
        if (!checkAuth(req)) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const { id } = req.query;
        if (id && jobs.has(id)) {
            jobs.delete(id);
        }
        res.json({ ok: true });
    });
}

/**
 * Execute the fetch in background and store the result.
 */
async function runJobInBackground(jobId, { url, method = 'POST', headers = {}, body, rawResponse }) {
    const job = jobs.get(jobId);
    if (!job) return;

    let timeoutId;

    try {
        console.log(`[ImageJob] Starting job ${jobId}: ${method} ${url}`);

        const fetchOptions = {
            method,
            headers: { ...headers },
        };

        if (body && method !== 'GET') {
            if (typeof body === 'string') {
                fetchOptions.body = body;
            } else {
                fetchOptions.headers['Content-Type'] = fetchOptions.headers['Content-Type'] || 'application/json';
                fetchOptions.body = JSON.stringify(body);
            }
        }

        // Timeout: abort fetch after 120 seconds to prevent zombie jobs
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), 120_000);

        const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
        clearTimeout(timeoutId);

        const responseHeaders = {};
        for (const [k, v] of response.headers) {
            responseHeaders[k] = v;
        }

        let data;
        const contentType = response.headers.get('content-type') || '';

        if (rawResponse || contentType.startsWith('image/') || contentType.startsWith('application/zip') ||
            contentType.startsWith('application/octet-stream')) {
            // Binary response — convert to base64
            const buffer = Buffer.from(await response.arrayBuffer());
            data = {
                _binary: true,
                base64: buffer.toString('base64'),
                contentType,
            };
        } else if (contentType.includes('json')) {
            data = await response.json();
        } else {
            data = await response.text();
        }

        job.status = response.ok ? 'done' : 'error';
        job.result = {
            ok: response.ok,
            status: response.status,
            headers: responseHeaders,
            data,
        };
        job.completedAt = Date.now();

        console.log(`[ImageJob] Job ${jobId} completed: ${response.ok ? 'OK' : 'FAIL'} (${response.status})`);

    } catch (error) {
        clearTimeout(timeoutId);
        const errorMsg = error.name === 'AbortError'
            ? 'Request timeout: image generation took longer than 120 seconds'
            : (error.message || String(error));
        job.status = 'error';
        job.error = errorMsg;
        job.completedAt = Date.now();
        console.error(`[ImageJob] Job ${jobId} failed:`, errorMsg);
    }
}

module.exports = { registerImageJobRoutes };
