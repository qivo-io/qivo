/* Sealed archive cursors (lib/archivedTasks.ts archiveCursorText).
 *
 * An archive cursor names the last task a page looked at. When a page reads
 * the organization's whole archive, that task can belong to a project the
 * caller cannot see, so its id and times must not reach the caller. The
 * cursor therefore goes out sealed with AES-256-GCM-SIV (RFC 8452) from
 * @noble/ciphers, which is plain JavaScript and runs the same in the Convex
 * isolate and in the edge-runtime tests. GCM-SIV derives its IV from the
 * text, which keeps a fixed nonce safe: equal positions seal to equal text,
 * and nothing else about a position shows. A changed, foreign or malformed
 * token fails the tag and opens to null, so callers can only pass back
 * positions a page gave them, never choose one.
 *
 * Key: SHA-256(BETTER_AUTH_SECRET + ':qivo-archive-cursor-v1'), derived the
 * way lib/fileTokens.ts derives its key, under its own label, so there is no
 * further env var to forget and neither key works for the other. Rotating
 * the secret only ends open page sequences, whose next cursor stops opening.
 * Deterministic given key and text, so legal inside a query.
 *
 * Every kind of archive cursor shares this key, so each one's text names
 * its kind inside what it seals, and one kind never opens as another. A
 * cursor of the app's Archived tasks page seals a digest of its scope
 * (digestText), which keeps it one length however many projects the scope
 * names. */

import { gcmsiv } from '@noble/ciphers/aes.js'
import { bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from '@noble/ciphers/utils.js'

/* Web Crypto: present in the isolate and in edge-runtime, but convex/tsconfig's
 * lib is ESNext only, which does not declare it (as in lib/fileTokens.ts). */
declare const crypto: {
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> }
}

const KEY_LABEL = ':qivo-archive-cursor-v1'
const NONCE = new Uint8Array(12)
const AAD = utf8ToBytes('qivo-archive-cursor')
/* GCM-SIV appends a 16-byte tag, so a sealed cursor is at least that long. */
const TAG_BYTES = 16

const secret = (): string => {
  const value = process.env.BETTER_AUTH_SECRET
  if (value === undefined || value === '') {
    throw new Error('BETTER_AUTH_SECRET is not set, so archive cursors cannot be sealed')
  }
  return value
}

/* One derived key per secret per isolate. */
const keys = new Map<string, Promise<Uint8Array>>()

const keyFor = (value: string): Promise<Uint8Array> => {
  let key = keys.get(value)
  if (key === undefined) {
    key = crypto.subtle
      .digest('SHA-256', utf8ToBytes(value + KEY_LABEL))
      .then((digest) => new Uint8Array(digest))
    keys.set(value, key)
  }
  return key
}

/** The SHA-256 of `text`, as 64 lowercase hex characters. */
export async function digestText(text: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8ToBytes(text))))
}

/** `text` sealed, as lowercase hex. */
export async function sealCursorText(text: string): Promise<string> {
  const key = await keyFor(secret())
  return bytesToHex(gcmsiv(key, NONCE, AAD).encrypt(utf8ToBytes(text)))
}

/** The text `sealed` holds, or null when it is malformed, changed or sealed
 * under another key. */
export async function openCursorText(sealed: string): Promise<string | null> {
  if (!/^(?:[0-9a-f]{2})+$/.test(sealed) || sealed.length < 2 * TAG_BYTES) return null
  const key = await keyFor(secret())
  try {
    return bytesToUtf8(gcmsiv(key, NONCE, AAD).decrypt(hexToBytes(sealed)))
  } catch {
    return null
  }
}
