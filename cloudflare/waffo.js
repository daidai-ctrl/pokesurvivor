/* Waffo Pancake helpers for the Cloudflare Worker.
 *
 * This module intentionally uses Web Crypto instead of the Node-only Waffo
 * SDK transport so it can run in a Cloudflare Worker. The private API key is
 * read only from a Worker Secret and is never returned to the browser.
 */

const WAFFO_API = 'https://api.waffo.ai';
const PROD_WEBHOOK_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAz+xApdTIb4ua+DgZKQ54
iBsD82ybyhGCLRETONW4Jgbb3A8DUM1LqBk6r/CmTOCHqLalTQHNigvP3R5zkDNX
iRJz6gA4MJ/+8K0+mnEE2RISQzN+Qu65TNd6svb+INm/kMaftY4uIXr6y6kchtTJ
dwnQhcKdAL2v7h7IFnkVelQsKxDdb2PqX8xX/qwd01iXvMcpCCaXovUwZsxH2QN5
ZKBTseJivbhUeyJCco4fdUyxOMHe2ybCVhyvim2uxAl1nkvL5L8RCWMCAV55LLo0
9OhmLahz/DYNu13YLVP6dvIT09ZFBYU6Owj1NxdinTynlJCFS9VYwBgmftosSE1U
dwIDAQAB
-----END PUBLIC KEY-----`;

const textEncoder = new TextEncoder();
let privateKeyRaw = '';
let privateKeyPromise = null;
let publicKeyRaw = '';
let publicKeyPromise = null;

function base64Bytes(value) {
  const clean = String(value || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '='.repeat((4 - clean.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function keyBody(value, begin, end) {
  let raw = String(value || '').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1).trim();
  if (raw.includes(begin)) raw = raw.replace(begin, '').replace(end, '');
  return base64Bytes(raw);
}

function derLength(length) {
  if (length < 128) return Uint8Array.of(length);
  const bytes = [];
  for (let n = length; n; n = Math.floor(n / 256)) bytes.unshift(n & 255);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function pkcs1ToPkcs8(pkcs1) {
  const algorithm = Uint8Array.of(
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d,
    0x01, 0x01, 0x01, 0x05, 0x00
  );
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const octetLength = derLength(pkcs1.length);
  const octet = new Uint8Array(1 + octetLength.length + pkcs1.length);
  octet[0] = 0x04;
  octet.set(octetLength, 1);
  octet.set(pkcs1, 1 + octetLength.length);
  const body = new Uint8Array(version.length + algorithm.length + octet.length);
  body.set(version, 0);
  body.set(algorithm, version.length);
  body.set(octet, version.length + algorithm.length);
  const sequenceLength = derLength(body.length);
  const sequence = new Uint8Array(1 + sequenceLength.length + body.length);
  sequence[0] = 0x30;
  sequence.set(sequenceLength, 1);
  sequence.set(body, 1 + sequenceLength.length);
  return sequence;
}

async function importPrivateKey(raw) {
  const normalized = String(raw || '').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  const der = normalized.includes('-----BEGIN RSA PRIVATE KEY-----')
    ? pkcs1ToPkcs8(keyBody(normalized, '-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----'))
    : keyBody(normalized, '-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----');
  return crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
}

async function importPublicKey(raw) {
  const der = keyBody(raw, '-----BEGIN PUBLIC KEY-----', '-----END PUBLIC KEY-----');
  return crypto.subtle.importKey(
    'spki', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );
}

function b64(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Base64(value) {
  return b64(await crypto.subtle.digest('SHA-256', textEncoder.encode(value)));
}

async function signRequest(path, body, env, idempotencyKey) {
  const rawKey = String(env.WAFFO_API_PRIVATE_KEY || '');
  const merchantId = String(env.WAFFO_MERCHANT_ID || '');
  if (!rawKey || !merchantId) {
    const error = new Error('waffo_not_configured');
    error.code = 'waffo_not_configured';
    throw error;
  }
  if (rawKey !== privateKeyRaw) {
    privateKeyRaw = rawKey;
    privateKeyPromise = importPrivateKey(rawKey);
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = await sha256Base64(body);
  const canonical = `POST\n${path}\n${timestamp}\n${bodyHash}`;
  const signature = b64(await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', await privateKeyPromise, textEncoder.encode(canonical)
  ));
  return {
    'Content-Type': 'application/json',
    'X-Merchant-Id': merchantId,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
    ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {})
  };
}

export async function waffoPost(env, path, value, idempotencyKey = '') {
  const body = JSON.stringify(value || {});
  const headers = await signRequest(path, body, env, idempotencyKey);
  const response = await fetch(WAFFO_API + path, { method: 'POST', headers, body });
  let envelope = null;
  try { envelope = await response.json(); } catch (e) { /* handled below */ }
  if (!response.ok || !envelope || (envelope.errors && envelope.errors.length)) {
    const message = envelope && envelope.errors && envelope.errors[0] && envelope.errors[0].message;
    const error = new Error(message || `waffo_api_${response.status}`);
    error.code = 'waffo_api_error';
    error.status = response.status;
    throw error;
  }
  return envelope.data || {};
}

function signatureParts(header) {
  const parts = { t: '', v1: '' };
  for (const pair of String(header || '').split(',')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key === 't') parts.t = value;
    if (key === 'v1') parts.v1 = value;
  }
  return parts;
}

export async function verifyWaffoWebhook(rawBody, header, env) {
  const { t, v1 } = signatureParts(header);
  if (!t || !v1) throw new Error('waffo_signature_missing');
  const timestamp = Number(t);
  const age = Date.now() - timestamp;
  if (!Number.isFinite(timestamp) || age > 45 * 60 * 1000 || age < -60 * 1000) {
    throw new Error('waffo_signature_expired');
  }
  const rawKey = String(env.WAFFO_WEBHOOK_PROD_PUBLIC_KEY || PROD_WEBHOOK_PUBLIC_KEY);
  if (rawKey !== publicKeyRaw) {
    publicKeyRaw = rawKey;
    publicKeyPromise = importPublicKey(rawKey);
  }
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', await publicKeyPromise,
    base64Bytes(v1), textEncoder.encode(`${t}.${rawBody}`)
  );
  if (!valid) throw new Error('waffo_signature_invalid');
  return JSON.parse(rawBody);
}

export function checkoutProduct(itemId, env) {
  const products = {
    tickets10: {
      productId: String(env.WAFFO_PRODUCT_TICKETS10 || 'PROD_4pCwuWsV3A6kPZ871iQvIz'),
      quantity: 10
    },
    tickets100: {
      productId: String(env.WAFFO_PRODUCT_TICKETS100 || 'PROD_3XhWBmesENPBvQUwIbaErR'),
      quantity: 100
    }
  };
  return products[String(itemId || '')] || null;
}

export const WAFFO_STORE_ID = 'STO_3Ws9Mt0ZpGTUBD35MzAIbT';
