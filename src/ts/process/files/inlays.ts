import localforage from "localforage";
import { v4 } from "uuid";
import { getImageType } from "src/ts/media";
import { getDatabase } from "../../storage/database.svelte";
import { getModelInfo, LLMFlags, LLMFormat } from "src/ts/model/modellist";
import { asBuffer } from "../../util";
import { isNodeServer } from "src/ts/platform";
import { NodeStorage } from "../../storage/nodeStorage";

export type InlayAsset = {
    data: string | Blob
    /** File extension */
    ext: string
    height?: number
    name: string
    type: 'image' | 'video' | 'audio' | 'signature'
    width?: number
}

const inlayImageExts = [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'
]

const inlayAudioExts = [
    'wav', 'mp3', 'ogg', 'flac'
]

const inlayVideoExts = [
    'webm', 'mp4', 'mkv'
]

const localInlayStorage = localforage.createInstance({
    name: 'inlay',
    storeName: 'inlay'
})

// ── Node server: IndexedDB read-through cache over NodeStorage ──

type SerializedInlayAsset = {
    data: string
    ext: string
    height?: number
    name: string
    type: 'image' | 'video' | 'audio' | 'signature'
    width?: number
}

function base64ToBlobHelper(b64: string): Blob {
    const splitDataURI = b64.split(',');
    const byteString = atob(splitDataURI[1]);
    const mimeString = splitDataURI[0].split(':')[1].split(';')[0];
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
    return new Blob([ab], { type: mimeString });
}

function blobToBase64Helper(blob: Blob): Promise<string> {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    return new Promise<string>((resolve, reject) => {
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
    });
}

class NodeInlayStorage {
    private nodeStorage = new NodeStorage()
    private prefix = 'inlay/'

    private async serialize(asset: InlayAsset): Promise<Uint8Array> {
        let dataStr: string
        if (asset.data instanceof Blob) {
            dataStr = await blobToBase64Helper(asset.data)
        } else {
            dataStr = asset.data as string
        }
        const s: SerializedInlayAsset = { data: dataStr, ext: asset.ext, height: asset.height, name: asset.name, type: asset.type, width: asset.width }
        return new TextEncoder().encode(JSON.stringify(s))
    }

    private deserialize(buf: Buffer): InlayAsset {
        const json: SerializedInlayAsset = JSON.parse(new TextDecoder().decode(buf))
        let data: string | Blob = json.data.startsWith('data:') ? base64ToBlobHelper(json.data) : json.data
        return { data, ext: json.ext, height: json.height, name: json.name, type: json.type, width: json.width }
    }

    async setItem(id: string, asset: InlayAsset): Promise<void> {
        const bytes = await this.serialize(asset)
        await this.nodeStorage.setItem(this.prefix + id, bytes)
        try { await localInlayStorage.setItem(id, asset) } catch { /* non-fatal */ }
    }

    async getItem<T>(id: string): Promise<T | null> {
        // Read-through: check local IndexedDB cache first
        try {
            const cached = await localInlayStorage.getItem<T>(id)
            if (cached) return cached
        } catch { /* ignore */ }

        try {
            const buf = await this.nodeStorage.getItem(this.prefix + id)
            if (!buf || buf.length === 0) return null
            const asset = this.deserialize(buf)
            try { await localInlayStorage.setItem(id, asset) } catch { /* non-fatal */ }
            return asset as unknown as T
        } catch {
            return null
        }
    }

    async removeItem(id: string): Promise<void> {
        try { await this.nodeStorage.removeItem(this.prefix + id) } catch { /* ignore */ }
        try { await localInlayStorage.removeItem(id) } catch { /* non-fatal */ }
    }

    async iterate<T, U>(callback: (value: T, key: string, iterationNumber: number) => U): Promise<U> {
        const allKeys = await this.nodeStorage.keys()
        const inlayKeys = allKeys.filter(k => k.startsWith(this.prefix))
        let result: U
        let i = 0
        for (const key of inlayKeys) {
            const id = key.replace(this.prefix, '')
            try {
                const buf = await this.nodeStorage.getItem(key)
                if (buf && buf.length > 0) {
                    const asset = this.deserialize(buf)
                    result = callback(asset as unknown as T, id, i)
                    i++
                }
            } catch { /* skip */ }
        }
        return result
    }
}

let _nodeInlayStorage: NodeInlayStorage | null = null

function getInlayStorage(): any {
    if (isNodeServer) {
        if (!_nodeInlayStorage) _nodeInlayStorage = new NodeInlayStorage()
        return _nodeInlayStorage
    }
    return localInlayStorage
}

const inlayStorage = isNodeServer ? null : localInlayStorage // legacy compat — use getInlayStorage() below

export async function postInlayAsset(img:{
    name:string,
    data:Uint8Array
}){

    const extention = img.name.split('.').at(-1)
    const imgObj = new Image()

    if(inlayImageExts.includes(extention)){
        imgObj.src = URL.createObjectURL(new Blob([asBuffer(img.data)], {type: `image/${extention}`}))

        return await writeInlayImage(imgObj, {
            name: img.name,
            ext: extention
        })
    }

    if(inlayAudioExts.includes(extention)){
        const audioBlob = new Blob([asBuffer(img.data)], {type: `audio/${extention}`})
        const imgid = v4()

        await getInlayStorage().setItem(imgid, {
            name: img.name,
            data: audioBlob,
            ext: extention,
            type: 'audio'
        })

        return `${imgid}`
    }

    if(inlayVideoExts.includes(extention)){
        const videoBlob = new Blob([asBuffer(img.data)], {type: `video/${extention}`})
        const imgid = v4()

        await getInlayStorage().setItem(imgid, {
            name: img.name,
            data: videoBlob,
            ext: extention,
            type: 'video'
        })

        return `${imgid}`
    }

    return null
}

export async function writeInlayImage(imgObj:HTMLImageElement, arg:{name?:string, ext?:string, id?:string} = {}) {

    let drawHeight = 0
    let drawWidth = 0
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    await new Promise((resolve) => {
        imgObj.onload = () => {
            drawHeight = imgObj.height
            drawWidth = imgObj.width

            //resize image to fit inlay, if total pixels exceed 1024*1024
            const maxPixels = 1024 * 1024
            const currentPixels = drawHeight * drawWidth
            
            if(currentPixels > maxPixels){
                const scaleFactor = Math.sqrt(maxPixels / currentPixels)
                drawWidth = Math.floor(drawWidth * scaleFactor)
                drawHeight = Math.floor(drawHeight * scaleFactor)
            }

            canvas.width = drawWidth
            canvas.height = drawHeight
            ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight)
            resolve(null)
        }
    })
    const imageBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));


    const imgid = arg.id ?? v4()

    await getInlayStorage().setItem(imgid, {
        name: arg.name ?? imgid,
        data: imageBlob,
        ext: 'png',
        height: drawHeight,
        width: drawWidth,
        type: 'image'
    })

    return `${imgid}`
}

export type InlaySignature = {
    signatures: {
        type: 'function'|'text'
        content: string
    }[],
    sourceFormat: LLMFormat,
    source: string
}

export async function saveInlayedSignature(sigid:string,signature:InlaySignature){
    await getInlayStorage().setItem(sigid, {
        name: sigid,
        data: JSON.stringify(signature),
        ext: 'json',
        type: 'signature'
    } satisfies InlayAsset)
    return sigid
}


function base64ToBlob(b64: string): Blob {
    const splitDataURI = b64.split(',');
    const byteString = atob(splitDataURI[1]);
    const mimeString = splitDataURI[0].split(':')[1].split(';')[0];

    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
    }

    return new Blob([ab], { type: mimeString });
}

function blobToBase64(blob: Blob): Promise<string> {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    return new Promise<string>((resolve, reject) => {
        reader.onloadend = () => {
            resolve(reader.result as string);
        };
        reader.onerror = reject;
    });
}

// Returns with base64 data URI
export async function getInlayAsset(id: string){
    const img = await getInlayStorage().getItem<InlayAsset | null>(id)
    if(img === null){
        return null
    }

    let data: string;
    if(img.data instanceof Blob){
        data = await blobToBase64(img.data)
    } else {
        data = img.data as string
    }

    return { ...img, data }
}

// Returns with Blob
export async function getInlayAssetBlob(id: string){
    const img = await getInlayStorage().getItem<InlayAsset | null>(id)
    if(img === null){
        return null
    }

    let data: Blob;
    if(typeof img.data === 'string'){
        // Migrate to Blob
        data = base64ToBlob(img.data)
        setInlayAsset(id, { ...img, data })
    } else {
        data = img.data
    }

    return { ...img, data }
}

export async function listInlayAssets(): Promise<[id: string, InlayAsset][]> {
    const assets: [id: string, InlayAsset][] = []
    await getInlayStorage().iterate<InlayAsset, void>((value, key) => {
        assets.push([key, value])
    })

    return assets
}

export async function setInlayAsset(id: string, img: InlayAsset){
    await getInlayStorage().setItem(id, img)
}

export async function removeInlayAsset(id: string){
    await getInlayStorage().removeItem(id)
}

export function supportsInlayImage(){
    const db = getDatabase()
    return getModelInfo(db.aiModel).flags.includes(LLMFlags.hasImageInput)
}

export async function reencodeImage(img:Uint8Array){
    if(getImageType(img) === 'PNG'){
        return img
    }
    const canvas = document.createElement('canvas')
    const imgObj = new Image()
    imgObj.src = URL.createObjectURL(new Blob([asBuffer(img)], {type: `image/png`}))
    await imgObj.decode()
    let drawHeight = imgObj.height
    let drawWidth = imgObj.width
    canvas.width = drawWidth
    canvas.height = drawHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight)
    const b64 = canvas.toDataURL('image/png').split(',')[1]
    const b = Buffer.from(b64, 'base64')
    return b
}