import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as FS from 'expo-file-system/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { BinaryUploader } from '../core/api-client';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Uint8Array(256);
for (let i = 0; i < B64.length; i++) LOOKUP[B64.charCodeAt(i)] = i;

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = LOOKUP[clean.charCodeAt(i)]!, b = LOOKUP[clean.charCodeAt(i + 1)]!;
    const c = LOOKUP[clean.charCodeAt(i + 2)] ?? 0, d = LOOKUP[clean.charCodeAt(i + 3)] ?? 0;
    out[o++] = (a << 2) | (b >> 4);
    if (i + 2 < clean.length) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < clean.length) out[o++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, o);
}

const EVIDENCE_DIR = `${FS.documentDirectory}evidence/`;

/**
 * Compress (1600 px, JPEG 0.8) → move into the app sandbox → SHA-256 of the FINAL bytes.
 * The hash goes into EvidenceCaptured, binding the photo to the hash chain.
 */
export async function storeEvidencePhoto(tempUri: string, sessionId: string, name: string): Promise<{ uri: string; sha256: string; bytes: number }> {
  const ctx = ImageManipulator.manipulate(tempUri).resize({ width: 1600 });
  const img = await ctx.renderAsync();
  const saved = await img.saveAsync({ compress: 0.8, format: SaveFormat.JPEG });
  const dir = `${EVIDENCE_DIR}${sessionId}/`;
  await FS.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
  const uri = `${dir}${name}.jpg`;
  await FS.moveAsync({ from: saved.uri, to: uri });
  const b64 = await FS.readAsStringAsync(uri, { encoding: FS.EncodingType.Base64 });
  const bytes = base64ToBytes(b64);
  return { uri, sha256: bytesToHex(sha256(bytes)), bytes: bytes.length };
}

export const expoUploader: BinaryUploader = async ({ url, fileUri, headers }) => {
  const r = await FS.uploadAsync(url, fileUri, { httpMethod: 'PUT', uploadType: FS.FileSystemUploadType.BINARY_CONTENT, headers });
  return { status: r.status, body: r.body };
};

export async function freeBytes(): Promise<number | null> {
  try {
    return await FS.getFreeDiskStorageAsync();
  } catch {
    return null;
  }
}

export async function deleteFile(uri: string) {
  await FS.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
}
