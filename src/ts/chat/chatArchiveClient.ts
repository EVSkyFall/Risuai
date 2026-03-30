/**
 * chatArchiveClient.ts
 * 
 * Frontend client for the server-side chat archive API.
 * Only functional in node-server mode — calls are no-ops in browser/tauri mode.
 */

import type { Message } from '../storage/database.svelte'

function getNodePassword(): string {
    return localStorage.getItem('risuauth') || ''
}

function getServerBaseUrl(): string {
    return window.location.origin
}

export interface ArchiveInfo {
    totalArchived: number
    archiveFiles: number
    oldestTimestamp: number | null
    newestTimestamp: number | null
}

/**
 * Load archived (old) messages from the server.
 * @returns Array of Message objects from archives, ordered oldest→newest.
 */
export async function fetchArchivedMessages(
    chaId: string,
    chatPage: number,
    offset: number = 0,
    limit: number = 100
): Promise<Message[]> {
    try {
        const baseUrl = getServerBaseUrl()
        const password = getNodePassword()
        const params = new URLSearchParams({
            chaId,
            chatPage: String(chatPage),
            offset: String(offset),
            limit: String(limit),
        })

        const response = await fetch(`${baseUrl}/api/chat/archive/load?${params}`, {
            headers: { 'risu-auth': password },
        })

        if (!response.ok) {
            console.error('[ArchiveClient] Load failed:', response.status)
            return []
        }

        const data = await response.json()
        return data.messages || []
    } catch (error) {
        console.error('[ArchiveClient] Load error:', error)
        return []
    }
}

/**
 * Get archive metadata (total count, file count, timestamps).
 */
export async function fetchArchiveInfo(
    chaId: string,
    chatPage: number
): Promise<ArchiveInfo> {
    try {
        const baseUrl = getServerBaseUrl()
        const password = getNodePassword()
        const params = new URLSearchParams({
            chaId,
            chatPage: String(chatPage),
        })

        const response = await fetch(`${baseUrl}/api/chat/archive/info?${params}`, {
            headers: { 'risu-auth': password },
        })

        if (!response.ok) {
            return { totalArchived: 0, archiveFiles: 0, oldestTimestamp: null, newestTimestamp: null }
        }

        return await response.json()
    } catch (error) {
        console.error('[ArchiveClient] Info error:', error)
        return { totalArchived: 0, archiveFiles: 0, oldestTimestamp: null, newestTimestamp: null }
    }
}

/**
 * Manually trigger archiving of old messages.
 */
export async function triggerArchive(
    chaId: string,
    chatPage: number
): Promise<{ archivedCount: number; remainingCount: number }> {
    try {
        const baseUrl = getServerBaseUrl()
        const password = getNodePassword()

        const response = await fetch(`${baseUrl}/api/chat/archive/trigger`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'risu-auth': password,
            },
            body: JSON.stringify({ chaId, chatPage }),
        })

        if (!response.ok) {
            console.error('[ArchiveClient] Trigger failed:', response.status)
            return { archivedCount: 0, remainingCount: 0 }
        }

        return await response.json()
    } catch (error) {
        console.error('[ArchiveClient] Trigger error:', error)
        return { archivedCount: 0, remainingCount: 0 }
    }
}
