/**
 * Server-Side Inlay Image Client
 * 
 * Frontend client for the server-side inlay image storage API.
 * Replaces localforage-based storage when running in node-risu mode.
 */

import type { InlayAsset } from './inlays';

/**
 * Get the node-risu auth password from localStorage.
 */
function getNodePassword(): string {
    return localStorage.getItem('risuauth') || '';
}

/**
 * Get the base URL for the node-risu server.
 */
function getServerBaseUrl(): string {
    return window.location.origin;
}

/**
 * Upload an inlay image to the server.
 * 
 * @param data - Base64 data URI or raw base64 string
 * @param name - Display name for the asset
 * @param type - Asset type ('image', 'video', 'audio')
 * @returns The server-assigned UUID, or null on failure
 */
export async function postInlayAssetServer(
    data: string,
    name: string = 'untitled',
    type: 'image' | 'video' | 'audio' = 'image'
): Promise<{ id: string; width: number; height: number } | null> {
    try {
        const baseUrl = getServerBaseUrl();
        const password = getNodePassword();

        const response = await fetch(`${baseUrl}/api/inlay/upload`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'risu-auth': password,
            },
            body: JSON.stringify({ data, name, type }),
        });

        if (!response.ok) {
            console.error('[InlayServer] Upload failed:', response.status);
            return null;
        }

        return await response.json();
    } catch (error) {
        console.error('[InlayServer] Upload error:', error);
        return null;
    }
}

/**
 * Get an inlay image from the server as a base64 data URI.
 * 
 * @param id - The server-assigned UUID
 * @returns InlayAsset-compatible object, or null if not found
 */
export async function getInlayAssetServer(id: string): Promise<InlayAsset | null> {
    try {
        const baseUrl = getServerBaseUrl();
        const password = getNodePassword();

        const response = await fetch(`${baseUrl}/api/inlay/${id}?format=base64`, {
            headers: { 'risu-auth': password },
        });

        if (!response.ok) {
            if (response.status === 404) return null;
            console.error('[InlayServer] Get failed:', response.status);
            return null;
        }

        const data = await response.json();
        return {
            data: data.data,
            ext: data.ext || 'png',
            height: data.height || 0,
            width: data.width || 0,
            name: data.name || id,
            type: data.type || 'image',
        };
    } catch (error) {
        console.error('[InlayServer] Get error:', error);
        return null;
    }
}

/**
 * Delete an inlay image from the server.
 */
export async function deleteInlayAssetServer(id: string): Promise<boolean> {
    try {
        const baseUrl = getServerBaseUrl();
        const password = getNodePassword();

        const response = await fetch(`${baseUrl}/api/inlay/${id}`, {
            method: 'DELETE',
            headers: { 'risu-auth': password },
        });

        return response.ok;
    } catch (error) {
        console.error('[InlayServer] Delete error:', error);
        return false;
    }
}

/**
 * List all inlay assets from the server.
 */
export async function listInlayAssetsServer(): Promise<{
    id: string;
    name: string;
    type: string;
    width: number;
    height: number;
}[]> {
    try {
        const baseUrl = getServerBaseUrl();
        const password = getNodePassword();

        const response = await fetch(`${baseUrl}/api/inlay/list/all`, {
            headers: { 'risu-auth': password },
        });

        if (!response.ok) return [];

        const data = await response.json();
        return data.items || [];
    } catch (error) {
        console.error('[InlayServer] List error:', error);
        return [];
    }
}

/**
 * Migrate existing localforage inlay data to the server (one-time operation).
 * 
 * @param assets - Array of inlay assets from localforage
 * @returns Number of successfully migrated assets
 */
export async function migrateInlaysToServer(
    assets: Array<{ id: string; data: string; name: string; type: string; width: number; height: number; ext: string }>
): Promise<number> {
    try {
        const baseUrl = getServerBaseUrl();
        const password = getNodePassword();

        const response = await fetch(`${baseUrl}/api/inlay/migrate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'risu-auth': password,
            },
            body: JSON.stringify({ assets }),
        });

        if (!response.ok) return 0;

        const data = await response.json();
        return data.migrated || 0;
    } catch (error) {
        console.error('[InlayServer] Migration error:', error);
        return 0;
    }
}
