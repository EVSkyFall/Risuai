/**
 * serverJobClient.ts
 * 
 * Frontend client for the server-side async job API.
 * Used by stableDiff.ts to offload image generation to the server.
 */

interface FetchResult {
    ok: boolean
    data: any
    headers: Record<string, string>
    status: number
}

function getNodePassword(): string {
    return localStorage.getItem('risuauth') || ''
}

function getServerBaseUrl(): string {
    return window.location.origin
}

interface JobSubmitResult {
    jobId: string
}

interface JobStatusResult {
    status: 'pending' | 'done' | 'error'
    result?: {
        ok: boolean
        status: number
        headers: Record<string, string>
        data: any
    }
    error?: string
}

/**
 * Submit a fetch job to the server for background execution.
 */
export async function submitJob(
    url: string,
    args: {
        method?: string
        headers?: Record<string, string>
        body?: any
        rawResponse?: boolean
    }
): Promise<JobSubmitResult> {
    const baseUrl = getServerBaseUrl()
    const password = getNodePassword()

    const response = await fetch(`${baseUrl}/api/job/submit`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'risu-auth': password,
        },
        body: JSON.stringify({
            url,
            method: args.method ?? 'POST',
            headers: args.headers ?? {},
            body: args.body,
            rawResponse: args.rawResponse ?? false,
        }),
    })

    if (!response.ok) {
        throw new Error(`Job submit failed: ${response.status}`)
    }

    return response.json()
}

/**
 * Check the status of a background job.
 */
export async function checkJobStatus(jobId: string): Promise<JobStatusResult> {
    const baseUrl = getServerBaseUrl()
    const password = getNodePassword()

    const response = await fetch(`${baseUrl}/api/job/status?id=${encodeURIComponent(jobId)}`, {
        headers: { 'risu-auth': password },
    })

    if (!response.ok) {
        throw new Error(`Job status check failed: ${response.status}`)
    }

    return response.json()
}

/**
 * Clear a completed job from the server.
 */
export async function clearJob(jobId: string): Promise<void> {
    const baseUrl = getServerBaseUrl()
    const password = getNodePassword()

    await fetch(`${baseUrl}/api/job/clear?id=${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers: { 'risu-auth': password },
    }).catch(() => { /* best-effort cleanup */ })
}

/**
 * Helper: decode base64 string to Uint8Array without relying on Node Buffer.
 * Uses atob() which is available in all browsers.
 */
function base64ToUint8Array(base64: string): Uint8Array {
    const binaryString = atob(base64)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i)
    }
    return bytes
}

/**
 * Submit a fetch request as a server-side async job and poll until completion.
 * Returns a result shaped like GlobalFetchResult for drop-in replacement of globalFetch.
 *
 * Key compatibility notes with globalFetch:
 * - body is passed as-is (object) to the server; server handles JSON.stringify for the outgoing request
 * - rawResponse flag is forwarded; server detects binary responses and returns { _binary, base64 }
 * - Binary data is reconstructed as Uint8Array (same as globalFetch's rawResponse format)
 */
export async function serverAsyncFetch(
    url: string,
    args: {
        method?: string
        headers?: Record<string, string>
        body?: any
        rawResponse?: boolean
    },
    pollIntervalMs: number = 1000
): Promise<FetchResult> {
    const { jobId } = await submitJob(url, args)

    try {
        const startTime = Date.now()
        const maxTimeoutMs = 150_000 // 150s (server 120s + 30s margin)

        while (true) {
            if (Date.now() - startTime > maxTimeoutMs) {
                clearJob(jobId)
                return {
                    ok: false,
                    data: 'Image generation timeout: exceeded 150 seconds',
                    headers: {},
                    status: 408,
                }
            }

            const status = await checkJobStatus(jobId)

            if ((status.status === 'done' || status.status === 'error') && status.result) {
                const result = status.result

                // Reconstruct binary data as Uint8Array (matching globalFetch's rawResponse format)
                if (result.data?._binary && result.data?.base64) {
                    result.data = base64ToUint8Array(result.data.base64)
                }

                return {
                    ok: result.ok,
                    data: result.data,
                    headers: result.headers,
                    status: result.status,
                }
            }

            if (status.status === 'error') {
                // Error without result data (e.g., network failure to the target)
                return {
                    ok: false,
                    data: status.error || 'Job failed',
                    headers: {},
                    status: 500,
                }
            }

            // Still pending — wait and poll again
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
        }
    } finally {
        // Best-effort cleanup
        clearJob(jobId)
    }
}
