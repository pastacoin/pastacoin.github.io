// Keys, signatures and amounts for the PaSta prototype chain, in the browser.
//
// This file must agree byte for byte with pasta/core/crypto.py and pasta/core/units.py in
// https://github.com/pastacoin/pastacoin :
//   * address     = Base58 of the raw 64-byte secp256k1 public key (x || y, no 0x04 prefix)
//   * private key = Base58 of the raw 32-byte scalar
//   * payload     = {"amount":<int>,"receiver":"..","sender":"..","timestamp":<int>}
//                   compact JSON, keys sorted, amount in whole base units
//   * tx_id       = SHA-256 hex of the payload
//   * signature   = Base58 of raw r || s (64 bytes), ECDSA over SHA-256 of the payload
// Private keys never leave this page: nothing here talks to the network.

import * as secp from "./vendor/noble-secp256k1.js";

// ------------------------------------------------------------------ Base58 ----
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function base58Decode(text) {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  let n = 0n;
  for (const c of text) {
    const v = ALPHABET_MAP.get(c);
    if (v === undefined) throw new Error("not Base58");
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes]);
}

// -------------------------------------------------------------------- keys ----
export function publicKeyFor(privateKeyB58) {
  const priv = base58Decode(privateKeyB58.trim());
  if (priv.length !== 32) throw new Error("a private key is 32 bytes");
  const pub = secp.getPublicKey(priv, false);          // 65 bytes: 0x04 || x || y
  return base58Encode(pub.slice(1));
}

export function generateKeypair() {
  const priv = secp.utils.randomPrivateKey();
  const private_key = base58Encode(priv);
  return { private_key, public_key: publicKeyFor(private_key) };
}

/** True when the text is a well-formed address: Base58 of 64 bytes. */
export function isAddress(text) {
  try {
    return base58Decode(text).length === 64;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- payload ----
function toBigIntAmount(amount) {
  const a = typeof amount === "bigint" ? amount : BigInt(amount);
  if (a < 0n) throw new Error("amount must be non-negative");
  return a;
}

export function canonicalPayload(sender, receiver, amount, timestamp) {
  // Addresses are Base58 (ASCII), so JSON.stringify renders them exactly as Python's json.dumps does.
  if (!Number.isSafeInteger(timestamp)) throw new Error("timestamp must be an integer");
  return `{"amount":${toBigIntAmount(amount)},"receiver":${JSON.stringify(receiver)},` +
         `"sender":${JSON.stringify(sender)},"timestamp":${timestamp}}`;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export async function computeTxId(sender, receiver, amount, timestamp) {
  const digest = await sha256(canonicalPayload(sender, receiver, amount, timestamp));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signTransaction(privateKeyB58, sender, receiver, amount, timestamp) {
  const digest = await sha256(canonicalPayload(sender, receiver, amount, timestamp));
  const sig = await secp.signAsync(digest, base58Decode(privateKeyB58.trim()));
  return base58Encode(sig.toCompactRawBytes());
}

// ------------------------------------------------------------------- units ----
// People type and read PASTA; the chain carries whole base units. BigInt only, no floats.

/** "1.5" -> 150000000n when unitsPerPasta is 100000000n. Throws on anything that is not an amount. */
export function toUnits(text, unitsPerPasta) {
  const s = String(text).trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) throw new Error("enter an amount like 1.5");
  const decimals = String(unitsPerPasta).length - 1;       // 100000000 -> 8
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  return BigInt(whole || "0") * BigInt(unitsPerPasta) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** 150000000n -> "1.5". `places` fixes the number of decimals (truncating) for tables. */
export function formatUnits(units, unitsPerPasta, places) {
  let u = typeof units === "bigint" ? units : BigInt(units);
  const per = BigInt(unitsPerPasta);
  const decimals = String(per).length - 1;
  const sign = u < 0n ? "-" : "";
  if (u < 0n) u = -u;
  const whole = (u / per).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = (u % per).toString().padStart(decimals, "0");
  if (places === undefined) frac = frac.replace(/0+$/, "");
  else frac = frac.slice(0, places);
  return sign + whole + (frac ? "." + frac : "");
}

/** JSON.parse that keeps integers too large for a double as strings (BigInt-ready). */
export function parseJsonExact(text) {
  return JSON.parse(text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,\}\]])/g, '$1"$2"'));
}
