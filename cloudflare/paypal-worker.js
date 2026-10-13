/* PokéSurvivor PayPal Worker.
 *
 * This Worker is deliberately separate from Waffo and from pokesurvivor-data.
 * Firebase Authentication remains the identity provider. PayPal orders and
 * ticket grants are idempotent records in D1; the browser never receives the
 * PayPal secret and never decides how many paid tickets to add.
 */
const PROJECT = 'pokesurvivor-xyz';
const PRICE = '9.90';
const PRICE_CENTS = 990;
const CURRENCY = 'USD';
const TICKETS = 10;
const ORIGINS = new Set([
  'https://pokesurvivor.xyz', 'https://www.pokesurvivor.xyz',
  'http://localhost:4173', 'http://127.0.0.1:4173',
  'http://localhost:8765', 'http://127.0.0.1:8765'
]);
const JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const PAYPAL_SANDBOX = 'https://api-m.sandbox.paypal.com';
const PAYPAL_LIVE = 'https://api-m.paypal.com';
let firebaseKeys = null, firebaseKeysAt = 0;
let paypalToken = '', paypalTokenExpiresAt = 0;

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
});

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ORIGINS.has(origin) ? origin : 'https://pokesurvivor.xyz',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400', Vary: 'Origin'
  };
}

function b64url(s) {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
}

async function verifyFirebase(token) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  let head, body;
  try {
    head = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    body = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch (e) { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (head.alg !== 'RS256' || body.aud !== PROJECT || body.iss !== 'https://securetoken.google.com/' + PROJECT
      || !body.sub || body.exp < now || body.iat > now + 300) return null;
  if (!firebaseKeys || Date.now() - firebaseKeysAt > 3600e3) {
    const r = await fetch(JWKS);
    if (!r.ok) return null;
    firebaseKeys = (await r.json()).keys; firebaseKeysAt = Date.now();
  }
  const jwk = firebaseKeys.find(k => k.kid === head.kid);
  if (!jwk) return null;
  try {
    const key = await crypto.subtle.importKey('jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1]));
    return ok ? body.sub : null;
  } catch (e) { return null; }
}

async function authUid(req) {
  return verifyFirebase((req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
}

async function body(req) { try { return await req.json(); } catch (e) { return null; } }
function parse(value, fallback = null) { try { return JSON.parse(value || ''); } catch (e) { return fallback; } }
function paypalBase(env) { return String(env.PAYPAL_ENV || 'sandbox').toLowerCase() === 'live' ? PAYPAL_LIVE : PAYPAL_SANDBOX; }
function paypalEnabled(env) { return !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET); }

async function paypalAccessToken(env) {
  if (!paypalEnabled(env)) throw new Error('paypal_not_configured');
  if (paypalToken && Date.now() < paypalTokenExpiresAt) return paypalToken;
  const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const r = await fetch(paypalBase(env) + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new Error('paypal_auth_failed');
  paypalToken = data.access_token;
  paypalTokenExpiresAt = Date.now() + Math.max(30, Number(data.expires_in || 300) - 60) * 1000;
  return paypalToken;
}

async function paypalRequest(env, path, options = {}) {
  const token = await paypalAccessToken(env);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(options.headers || {}) };
  const r = await fetch(paypalBase(env) + path, { ...options, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('paypal_api_failed'); e.status = r.status; e.data = data; throw e; }
  return data;
}

function captureOf(order) {
  const unit = (order.purchase_units || [])[0] || {};
  const capture = (((unit.payments || {}).captures || [])[0]) || {};
  const amount = capture.amount || unit.amount || {};
  return { id: capture.id || '', status: capture.status || '', currency: amount.currency_code, value: amount.value };
}

function validateCapture(order, row) {
  const capture = captureOf(order);
  const amount = Number(capture.value);
  if (order.status !== 'COMPLETED' || capture.status !== 'COMPLETED'
      || !capture.id || capture.currency !== row.currency || !Number.isFinite(amount)
      || amount.toFixed(2) !== PRICE) throw new Error('payment_not_completed');
  return capture;
}

async function recordCapture(env, row, capture) {
  const now = Date.now();
  const grantId = crypto.randomUUID();
  await env.pokesurvivor_data.batch([
    env.pokesurvivor_data.prepare(
      'UPDATE paypal_orders SET status = ?, capture_id = ?, updated_at = ? WHERE internal_id = ?'
    ).bind('captured', capture.id, now, row.internal_id),
    env.pokesurvivor_data.prepare(
      `INSERT OR IGNORE INTO ticket_grants
       (grant_id, order_internal_id, paypal_order_id, uid, tickets_t1, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).bind(grantId, row.internal_id, row.paypal_order_id, row.uid, row.tickets_t1, now, now)
  ]);
  const grant = await env.pokesurvivor_data.prepare(
    'SELECT grant_id, tickets_t1, status FROM ticket_grants WHERE order_internal_id = ?'
  ).bind(row.internal_id).first();
  return { grantId: grant && grant.grant_id, tickets: Number(grant && grant.tickets_t1 || row.tickets_t1), status: grant && grant.status };
}

async function createOrder(env, uid, requestId) {
  if (requestId) {
    const existing = await env.pokesurvivor_data.prepare(
      'SELECT internal_id, paypal_order_id, status FROM paypal_orders WHERE uid = ? AND client_request_id = ?'
    ).bind(uid, requestId).first();
    if (existing) return existing;
  }
  const internalId = crypto.randomUUID();
  const order = await paypalRequest(env, '/v2/checkout/orders', {
    method: 'POST',
    headers: { 'PayPal-Request-Id': internalId },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: internalId,
        custom_id: internalId,
        invoice_id: internalId,
        description: 'PokéSurvivor · 10 Gacha Tickets',
        amount: { currency_code: CURRENCY, value: PRICE }
      }]
    })
  });
  const now = Date.now();
  await env.pokesurvivor_data.prepare(
    `INSERT INTO paypal_orders
     (internal_id, paypal_order_id, uid, amount_cents, currency, tickets_t1, status, client_request_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)`
  ).bind(internalId, order.id, uid, PRICE_CENTS, CURRENCY, TICKETS, requestId || null, now, now).run();
  return { internal_id: internalId, paypal_order_id: order.id, status: order.status, links: order.links || [] };
}

async function captureOrder(env, uid, paypalOrderId) {
  const row = await env.pokesurvivor_data.prepare(
    'SELECT * FROM paypal_orders WHERE paypal_order_id = ? AND uid = ?'
  ).bind(paypalOrderId, uid).first();
  if (!row) return { error: 'order_not_found', status: 404 };
  if (row.status === 'captured') return recordCapture(env, row, { id: row.capture_id, status: 'COMPLETED', currency: row.currency, value: PRICE });

  // Read first so a retry after a successful PayPal capture is idempotent and
  // does not send a second capture request.
  let order = null;
  try {
    order = await paypalRequest(env, `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, { method: 'GET' });
  } catch (e) { /* fall through to capture */ }

  if (!order || order.status !== 'COMPLETED') {
    try {
      order = await paypalRequest(env, `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
        method: 'POST', headers: { 'PayPal-Request-Id': 'capture-' + row.internal_id }, body: '{}'
      });
    } catch (e) {
      // PayPal can complete the capture while the browser or Worker times out.
      // Read the order back on every capture error before reporting failure.
      try {
        const latest = await paypalRequest(env, `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, { method: 'GET' });
        if (latest.status === 'COMPLETED') order = latest;
        else throw e;
      } catch (readError) {
        throw e;
      }
    }
  }

  if (!order || order.status !== 'COMPLETED') {
    throw new Error('payment_not_completed');
  }
  const capture = validateCapture(order, row);
  const grant = await recordCapture(env, row, capture);
  return { orderId: paypalOrderId, status: 'COMPLETED', ...grant };
}

async function verifyWebhook(env, req, event) {
  if (!env.PAYPAL_WEBHOOK_ID) return false;
  const headers = req.headers;
  const payload = {
    auth_algo: headers.get('PAYPAL-AUTH-ALGO'),
    cert_url: headers.get('PAYPAL-CERT-URL'),
    transmission_id: headers.get('PAYPAL-TRANSMISSION-ID'),
    transmission_sig: headers.get('PAYPAL-TRANSMISSION-SIG'),
    transmission_time: headers.get('PAYPAL-TRANSMISSION-TIME'),
    webhook_id: env.PAYPAL_WEBHOOK_ID,
    webhook_event: event
  };
  if (Object.values(payload).some(v => !v)) return false;
  const result = await paypalRequest(env, '/v1/notifications/verify-webhook-signature', {
    method: 'POST', body: JSON.stringify(payload)
  });
  return result.verification_status === 'SUCCESS';
}

async function claimGrant(env, uid, grantId) {
  const now = Date.now();
  const locked = await env.pokesurvivor_data.prepare(
    `UPDATE ticket_grants SET status = 'processing', locked_at = ?, updated_at = ?
     WHERE grant_id = ? AND uid = ? AND (status = 'pending' OR (status = 'processing' AND locked_at < ?))`
  ).bind(now, now, grantId, uid, now - 5 * 60 * 1000).run();
  if (!locked.meta || !locked.meta.changes) {
    const current = await env.pokesurvivor_data.prepare('SELECT status FROM ticket_grants WHERE grant_id = ? AND uid = ?').bind(grantId, uid).first();
    if (current && current.status === 'claimed') return { ok: true, status: 'claimed', alreadyClaimed: true };
    return { error: current ? 'grant_busy' : 'grant_not_found', status: current ? 409 : 404 };
  }
  const grant = await env.pokesurvivor_data.prepare('SELECT * FROM ticket_grants WHERE grant_id = ? AND uid = ?').bind(grantId, uid).first();
  if (!grant) return { error: 'grant_not_found', status: 404 };
  const apply = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await env.pokesurvivor_data.prepare('SELECT payload, game_updated FROM saves WHERE uid = ?').bind(uid).first();
      if (!row) return { error: 'sync_required', status: 409 };
      const save = parse(row.payload, null);
      if (!save || typeof save !== 'object') return { error: 'save_invalid', status: 409 };
      save.tickets = save.tickets || { t1: 0, t10: 0 };
      save.tickets.t1 = Math.max(0, Number(save.tickets.t1) || 0) + Number(grant.tickets_t1 || 0);
      save.updated = Math.max(Number(save.updated) || 0, Date.now());
      const result = await env.pokesurvivor_data.prepare(
        'UPDATE saves SET payload = ?, game_updated = ?, updated_at = ? WHERE uid = ? AND game_updated = ?'
      ).bind(JSON.stringify(save), Math.floor(save.updated), Date.now(), uid, Number(row.game_updated || 0)).run();
      if (result.meta && result.meta.changes) return { save };
    }
    return { error: 'save_busy', status: 409 };
  };
  const result = await apply();
  if (result.error) {
    await env.pokesurvivor_data.prepare("UPDATE ticket_grants SET status = 'pending', locked_at = NULL, updated_at = ? WHERE grant_id = ? AND status = 'processing'").bind(Date.now(), grantId).run();
    return result;
  }
  await env.pokesurvivor_data.prepare("UPDATE ticket_grants SET status = 'claimed', claimed_at = ?, updated_at = ? WHERE grant_id = ? AND status = 'processing'").bind(Date.now(), Date.now(), grantId).run();
  return { ok: true, status: 'claimed', save: result.save };
}

async function handle(req, env, uid, url) {
  const path = url.pathname.replace(/^\/v1\/?/, '').replace(/\/$/, '');
  const method = req.method;
  if (path === 'config' && method === 'GET') return json({ enabled: paypalEnabled(env), clientId: env.PAYPAL_CLIENT_ID || '', environment: String(env.PAYPAL_ENV || 'sandbox').toLowerCase(), currency: CURRENCY, price: PRICE, tickets: TICKETS });
  if (path === 'orders' && method === 'POST') {
    const result = await createOrder(env, uid, (req.headers.get('Idempotency-Key') || '').slice(0, 120) || null);
    return json({ orderId: result.paypal_order_id, internalId: result.internal_id, status: result.status, links: result.links || [] });
  }
  const capture = path.match(/^orders\/([^/]+)\/capture$/);
  if (capture && method === 'POST') return json(await captureOrder(env, uid, decodeURIComponent(capture[1])));
  if (path === 'grants' && method === 'GET') {
    const rows = await env.pokesurvivor_data.prepare(
      "SELECT grant_id AS grantId, tickets_t1 AS tickets, status, created_at AS createdAt FROM ticket_grants WHERE uid = ? AND status = 'pending' ORDER BY created_at ASC"
    ).bind(uid).all();
    return json({ grants: rows.results || [] });
  }
  const grant = path.match(/^grants\/([^/]+)\/claim$/);
  if (grant && method === 'POST') return json(await claimGrant(env, uid, decodeURIComponent(grant[1])));
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(req, env) {
    const headers = cors(req.headers.get('Origin') || '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'pokesurvivor-paypal', environment: String(env.PAYPAL_ENV || 'sandbox').toLowerCase() }, 200, headers);
    if (url.pathname === '/v1/config' && req.method === 'GET') {
      const response = json({ enabled: paypalEnabled(env), clientId: env.PAYPAL_CLIENT_ID || '', environment: String(env.PAYPAL_ENV || 'sandbox').toLowerCase(), currency: CURRENCY, price: PRICE, tickets: TICKETS });
      Object.entries(headers).forEach(([k, v]) => response.headers.set(k, v));
      return response;
    }
    if (url.pathname === '/v1/webhook' && req.method === 'POST') {
      const event = await body(req);
      if (!event || !(await verifyWebhook(env, req, event))) return json({ error: 'invalid_webhook' }, 400, headers);
      if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
        const orderId = event.resource && event.resource.supplementary_data && event.resource.supplementary_data.related_ids && event.resource.supplementary_data.related_ids.order_id;
        if (orderId) {
          const row = await env.pokesurvivor_data.prepare('SELECT * FROM paypal_orders WHERE paypal_order_id = ?').bind(orderId).first();
          if (row) await recordCapture(env, row, { id: event.resource.id, status: 'COMPLETED', currency: row.currency, value: PRICE });
        }
      }
      return json({ ok: true }, 200, headers);
    }
    const uid = await authUid(req);
    if (!uid) return json({ error: 'unauthorized' }, 401, headers);
    try {
      const response = await handle(req, env, uid, url);
      Object.entries(headers).forEach(([k, v]) => response.headers.set(k, v));
      return response;
    } catch (e) {
      console.error('[paypal-worker]', e);
      const safeErrors = new Set(['paypal_not_configured', 'payment_not_completed']);
      return json({ error: safeErrors.has(e.message) ? e.message : 'server_error' }, e.status || 500, headers);
    }
  }
};
