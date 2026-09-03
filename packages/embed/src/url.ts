// =============================================================================
// @onegrid/embed — URL-safe block encoding.
//
// A block travels as a query-string parameter: the host stores one link, and
// the link *is* the block. That constrains the encoding hard.
//
//   - base64url (RFC 4648 §5), not base64. `+` and `/` are legal in a query
//     string but survive round-tripping through copy-paste, mail clients and
//     URL shorteners far less reliably than `-` and `_`, and `+` is decoded as
//     a space by every form-urlencoded parser in existence.
//   - No `=` padding. Padding is redundant (length mod 4 recovers it), and `=`
//     is a query-string separator that half the ecosystem re-escapes to `%3D`.
//   - The alphabet is implemented here rather than delegated to `btoa` /
//     `Buffer`. `btoa` throws on any code unit above U+00FF, so it cannot take
//     JSON containing a single non-ASCII character, and `Buffer` does not exist
//     in a browser. Text is UTF-8 encoded first, then base64url'd byte-wise, so
//     emoji column headers and CJK titles round-trip.
//   - A size guard, because exceeding a URL ceiling does not fail loudly: the
//     link silently truncates somewhere in the middle of the chain and the
//     block deserialises as garbage days later.
//
// The documented ceiling is 4096 encoded characters by default. The real limits
// vary — IE capped at 2083, modern browsers accept far more, but nginx's default
// `large_client_header_buffers` is 8k for the WHOLE request line including
// method, path, other params and protocol, and several CDNs cap at 8k too. 4096
// leaves room for the rest of the request while staying comfortably above what
// a descriptor with a few dozen columns needs. Raise it via `option.maxLength`
// if you control the whole path; if you are over it, switch the source to
// `named` (a key, not the data) instead.
// =============================================================================

import type { EmbedBlock } from './block';
import { deserializeBlock, serializeBlock } from './block';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Reverse lookup, built once. Index is the char code; -1 means "not in the
// alphabet" so decode can reject junk rather than silently treating it as 0.
const REVERSE: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/**
 * Default ceiling, in encoded characters, for an encoded block. See the module
 * header for why 4096.
 *
 * @public
 */
export const MAX_BLOCK_URL_LENGTH = 4096;

/**
 * Encode raw bytes as unpadded base64url.
 *
 * @public
 */
export function toBase64Url(byte: Uint8Array): string {
  let out = '';
  let i = 0;
  // Three input bytes become four output characters; the tail is handled after.
  for (; i + 2 < byte.length; i += 3) {
    const n = (byte[i]! << 16) | (byte[i + 1]! << 8) | byte[i + 2]!;
    out += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]! + ALPHABET[n & 63]!;
  }
  const remaining = byte.length - i;
  if (remaining === 1) {
    const n = byte[i]! << 16;
    out += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]!;
  } else if (remaining === 2) {
    const n = (byte[i]! << 16) | (byte[i + 1]! << 8);
    out += ALPHABET[(n >>> 18) & 63]! + ALPHABET[(n >>> 12) & 63]! + ALPHABET[(n >>> 6) & 63]!;
  }
  return out;
}

/**
 * Decode unpadded (or padded — trailing `=` is tolerated) base64url back to
 * bytes. Throws on any character outside the alphabet, so a truncated or
 * mangled link fails at the boundary instead of producing plausible garbage.
 *
 * @public
 */
export function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const full = Math.floor(clean.length / 4);
  const tail = clean.length - full * 4;
  if (tail === 1) {
    throw new Error('@onegrid/embed: malformed base64url — length % 4 === 1 is impossible.');
  }
  const outLength = full * 3 + (tail === 0 ? 0 : tail - 1);
  const out = new Uint8Array(outLength);
  let o = 0;
  let acc = 0;
  let bit = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? REVERSE[code]! : -1;
    if (value < 0) {
      throw new Error(`@onegrid/embed: malformed base64url — illegal character at index ${i}.`);
    }
    acc = (acc << 6) | value;
    bit += 6;
    if (bit >= 8) {
      bit -= 8;
      out[o++] = (acc >>> bit) & 0xff;
    }
  }
  return out;
}

/**
 * Options for {@link encodeBlockUrl}.
 *
 * @public
 */
export interface EncodeBlockUrlOption {
  /** Ceiling in encoded characters. Defaults to {@link MAX_BLOCK_URL_LENGTH}. */
  readonly maxLength?: number;
}

/**
 * Serialise, UTF-8 encode and base64url a block into a single query-safe token.
 * Throws when the result exceeds the ceiling — see the module header for why
 * failing loudly beats emitting a link that truncates in transit.
 *
 * @public
 */
export function encodeBlockUrl(block: EmbedBlock, option: EncodeBlockUrlOption = {}): string {
  const max = option.maxLength ?? MAX_BLOCK_URL_LENGTH;
  const encoded = toBase64Url(new TextEncoder().encode(serializeBlock(block)));
  if (encoded.length > max) {
    throw new Error(
      `@onegrid/embed: encoded block is ${encoded.length} characters, over the ${max}-character ceiling. ` +
        "Switch source.kind to 'named' so the link carries a key instead of the data, or raise option.maxLength if you control the whole request path.",
    );
  }
  return encoded;
}

/**
 * Reverse {@link encodeBlockUrl}, migrating the decoded descriptor up to the
 * current schema version on the way out.
 *
 * @public
 */
export function decodeBlockUrl(token: string): EmbedBlock {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(token));
  return deserializeBlock(text);
}

/**
 * Encoded length a block would occupy, without throwing. Use this to decide
 * between an inline link and a stored key before committing to one.
 *
 * @public
 */
export function measureBlockUrlLength(block: EmbedBlock): number {
  return toBase64Url(new TextEncoder().encode(serializeBlock(block))).length;
}

/**
 * Build a full embed URL: a base viewer URL with the encoded block attached
 * under `param` (default `b`). Existing query parameters on the base are
 * preserved.
 *
 * @public
 */
export function buildEmbedUrl(
  baseUrl: string,
  block: EmbedBlock,
  option: EncodeBlockUrlOption & { readonly param?: string } = {},
): string {
  const token = encodeBlockUrl(block, option);
  const param = option.param ?? 'b';
  // base64url is already query-safe, so it is appended raw rather than through
  // URLSearchParams — which would percent-encode nothing here but does reorder
  // and re-encode pre-existing parameters, changing a URL the caller wrote.
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}${encodeURIComponent(param)}=${token}`;
}

/**
 * Pull a block back out of a full embed URL produced by {@link buildEmbedUrl}.
 * Returns null when the parameter is absent; throws when it is present but
 * malformed, because a present-but-broken block is a bug, not a default.
 *
 * @public
 */
export function parseEmbedUrl(url: string, param = 'b'): EmbedBlock | null {
  const queryStart = url.indexOf('?');
  if (queryStart < 0) return null;
  const hashStart = url.indexOf('#', queryStart);
  const query = url.slice(queryStart + 1, hashStart < 0 ? undefined : hashStart);
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (decodeURIComponent(pair.slice(0, eq)) !== param) continue;
    return decodeBlockUrl(pair.slice(eq + 1));
  }
  return null;
}
