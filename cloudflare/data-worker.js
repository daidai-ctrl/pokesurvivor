import { checkoutProduct, WAFFO_STORE_ID, verifyWaffoWebhook, waffoPost } from './waffo.js';

/* PokéSurvivor data API.
 * Firebase Authentication is retained during migration so existing accounts
 * keep the same uid. The Worker verifies the Firebase ID token and uses D1 for
 * game data, rankings and social data.
 */
const PROJECT = 'pokesurvivor-xyz';
const ORIGINS = new Set([
  'https://pokesurvivor.xyz', 'https://www.pokesurvivor.xyz',
  'http://localhost:4173', 'http://127.0.0.1:4173',
  'http://localhost:8765', 'http://127.0.0.1:8765'
]);
const JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const TOP = 50;
// Campaign rewards are keyed by campaign so each campaign can be claimed once
// per account without changing the history of older campaigns.
const SHARE_CAMPAIGNS = Object.freeze({
  share_t1_5_v1: 5,
  arena_share_t1_3_v1: 3
});
const ARENA_FIRST_MATCH_CAMPAIGN = 'arena_first_match_t1_v1';
const ARENA_FIRST_MATCH_TICKETS = 1;
const WAFFO_MAX_BODY = 300000;
let keys = null, keysAt = 0;

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
});

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ORIGINS.has(origin) ? origin : 'https://pokesurvivor.xyz',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400', Vary: 'Origin'
  };
}

function b64url(s) {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
}

async function verify(token) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  let head, body;
  try {
    head = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    body = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch (e) { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (head.alg !== 'RS256' || body.aud !== PROJECT || body.iss !== 'https://securetoken.google.com/' + PROJECT) return null;
  if (!body.sub || body.exp < now || body.iat > now + 300) return null;
  if (!keys || Date.now() - keysAt > 3600e3) {
    const r = await fetch(JWKS);
    if (!r.ok) return null;
    keys = (await r.json()).keys; keysAt = Date.now();
  }
  const jwk = keys.find(k => k.kid === head.kid);
  if (!jwk) return null;
  try {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    return ok ? body.sub : null;
  } catch (e) { return null; }
}

async function readBody(req) { try { return await req.json(); } catch (e) { return null; } }
function parse(value, fallback = {}) { try { return JSON.parse(value || ''); } catch (e) { return fallback; } }

async function saveGet(env, uid) {
  const row = await env.pokesurvivor_data.prepare('SELECT payload FROM saves WHERE uid = ?').bind(uid).first();
  return row ? parse(row.payload, null) : null;
}

async function saveVersion(payload, gameUpdated) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(gameUpdated + ':' + payload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function saveState(env, uid) {
  const row = await env.pokesurvivor_data.prepare('SELECT payload, game_updated FROM saves WHERE uid = ?').bind(uid).first();
  if (!row) return { save: null, version: null, protocol: 2 };
  const save = parse(row.payload, null);
  return { save, version: save && save.syncV === 2 ? await saveVersion(row.payload, row.game_updated) : null, protocol: 2 };
}

async function savePut(env, uid, value) {
  // Old clients must never replace a versioned save without an expected version.
  const existing = await env.pokesurvivor_data.prepare('SELECT payload FROM saves WHERE uid = ?').bind(uid).first();
  if (existing && parse(existing.payload, {}).syncV === 2) return false;
  const now = Date.now();
  const gameUpdated = Math.floor(Number(value && value.updated) || 0);
  const result = await env.pokesurvivor_data.prepare(
    `INSERT INTO saves(uid, payload, game_updated, updated_at) VALUES(?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET payload=excluded.payload, game_updated=excluded.game_updated, updated_at=excluded.updated_at
     WHERE excluded.game_updated >= saves.game_updated
       AND COALESCE(json_extract(saves.payload, '$.syncV'), 0) != 2`
  ).bind(uid, JSON.stringify(value || {}), gameUpdated, now).run();
  return !!(result.meta && result.meta.changes);
}

async function savePutV2(env, uid, value, baseVersion) {
  let row;
  try {
    row = await env.pokesurvivor_data.prepare(
      `SELECT payload, game_updated,
              EXISTS(SELECT 1 FROM ticket_quarantines q WHERE q.uid = ?) AS tickets_quarantined
         FROM saves WHERE uid = ?`
    ).bind(uid, uid).first();
  } catch (error) {
    // Keep old preview/test databases usable while the additive flags table is
    // being created. Production has the table, so this path is only a safe
    // migration fallback and never disables the quarantine there.
    if (!/account_flags|no such table/i.test(String(error && (error.message || error.errstr) || error))) throw error;
    row = await env.pokesurvivor_data.prepare('SELECT payload, game_updated FROM saves WHERE uid = ?').bind(uid).first();
  }
  if (row) {
    const current = parse(row.payload, null);
    if (!current || current.syncV !== 2 || baseVersion !== await saveVersion(row.payload, row.game_updated)) return null;
  } else if (baseVersion !== null) return null;

  const storedValue = row && row.tickets_quarantined
    ? Object.assign({}, value, { tickets: Object.assign({}, value.tickets || {}, { t1: 0, t10: 0 }) })
    : value;
  const payload = JSON.stringify(storedValue);
  if (row && payload === row.payload) return await saveVersion(payload, row.game_updated);
  const now = Date.now();
  // Client clocks are not a concurrency primitive. Keep the legacy column
  // monotonic for the payment/reward writers, but use the payload CAS below.
  const gameUpdated = Math.max(now, Number(row && row.game_updated || 0) + 1);
  const result = row
    ? await env.pokesurvivor_data.prepare(
      'UPDATE saves SET payload = ?, game_updated = ?, updated_at = ? WHERE uid = ? AND game_updated = ? AND payload = ?'
    ).bind(payload, gameUpdated, now, uid, row.game_updated, row.payload).run()
    : await env.pokesurvivor_data.prepare(
      'INSERT OR IGNORE INTO saves(uid, payload, game_updated, updated_at) VALUES(?, ?, ?, ?)'
    ).bind(uid, payload, gameUpdated, now).run();
  return result.meta && result.meta.changes ? await saveVersion(payload, gameUpdated) : null;
}

function boundedText(value, max = 200) {
  return String(value == null ? '' : value).slice(0, max);
}

function objectKeyCount(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 0;
}

async function leaderboardHidden(env, uid) {
  const row = await env.pokesurvivor_data.prepare(
    "SELECT 1 AS hidden FROM account_flags WHERE uid = ? AND flag = 'leaderboard_hidden' LIMIT 1"
  ).bind(uid).first();
  return !!row;
}

function waffoMetadata(data) {
  const metadata = data && data.orderMetadata && typeof data.orderMetadata === 'object'
    ? data.orderMetadata : {};
  const quantity = Number(metadata.ticketQuantity);
  const uid = boundedText(data && data.merchantProvidedBuyerIdentity, 128);
  const orderId = boundedText(data && data.orderId, 128);
  const eventUidOk = /^[A-Za-z0-9_.:-]{6,128}$/.test(uid);
  const quantityOk = quantity === 10 || quantity === 100;
  const valid = metadata.game === 'pokesurvivor' &&
    metadata.reward === 'yellow_tickets' && eventUidOk && quantityOk && !!orderId;
  return { metadata, quantity, uid, orderId, valid };
}

async function createWaffoCheckout(env, uid, value) {
  const product = checkoutProduct(value && value.itemId, env);
  if (!product) return { error: 'invalid_product', status: 400 };
  const current = await saveState(env, uid);
  // A purchase is not opened until the CF save exists. This prevents a paid
  // order from being created for a user whose first save was never confirmed.
  if (!current.save || current.save.syncV !== 2) return { error: 'save_required', status: 409 };

  const clientRequestId = /^[A-Za-z0-9_-]{8,80}$/.test(String(value && value.requestId || ''))
    ? String(value.requestId) : crypto.randomUUID();
  const externalId = `PS:${product.quantity}:${clientRequestId}`.slice(0, 128);
  const token = await waffoPost(env, '/v1/actions/auth/issue-session-token', {
    productId: product.productId,
    buyerIdentity: uid
  });
  const session = await waffoPost(env, '/v1/actions/checkout/create-session', {
    productId: product.productId,
    currency: 'USD',
    orderMerchantExternalId: externalId,
    orderMetadata: {
      game: 'pokesurvivor',
      reward: 'yellow_tickets',
      ticketQuantity: String(product.quantity),
      clientRequestId
    }
  }, `ps-${uid.slice(0, 40)}-${clientRequestId}`.slice(0, 128));
  if (!token.token || !session.checkoutUrl) throw new Error('waffo_checkout_invalid_response');
  return { checkoutUrl: `${session.checkoutUrl}#token=${token.token}`, expiresAt: session.expiresAt };
}

async function rememberWaffoEvent(env, event) {
  const data = event && event.data || {};
  const eventId = boundedText(event && event.id, 128);
  if (!eventId) throw new Error('waffo_event_id_missing');
  const now = Date.now();
  const inserted = await env.pokesurvivor_data.prepare(
    `INSERT OR IGNORE INTO waffo_events
     (event_id, event_type, order_id, status, uid, tickets_t1, payload, created_at, updated_at)
     VALUES (?, ?, ?, 'processing', ?, 0, ?, ?, ?)`
  ).bind(eventId, boundedText(event.eventType, 80), boundedText(data.orderId, 128),
    boundedText(data.merchantProvidedBuyerIdentity, 128), JSON.stringify(event), now, now).run();
  if (inserted.meta && inserted.meta.changes) return { fresh: true, eventId };
  const existing = await env.pokesurvivor_data.prepare(
    'SELECT status FROM waffo_events WHERE event_id = ?'
  ).bind(eventId).first();
  return { fresh: false, eventId, status: existing && existing.status };
}

async function updateWaffoEvent(env, eventId, status, details = {}) {
  await env.pokesurvivor_data.prepare(
    `UPDATE waffo_events SET status = ?, uid = COALESCE(NULLIF(?, ''), uid),
       tickets_t1 = ?, error = ?, updated_at = ? WHERE event_id = ?`
  ).bind(status, boundedText(details.uid, 128), Number(details.tickets || 0),
    boundedText(details.error, 300) || null, Date.now(), eventId).run();
}

async function grantWaffoPurchase(env, event, info) {
  const existing = await env.pokesurvivor_data.prepare(
    'SELECT status FROM waffo_orders WHERE order_id = ?'
  ).bind(info.orderId).first();
  if (existing && ['granted', 'refund_review', 'refunded'].includes(existing.status)) {
    return { status: 'duplicate', tickets: 0 };
  }
  if (existing && existing.status === 'processing') throw new Error('waffo_grant_busy');

  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await env.pokesurvivor_data.prepare(
      'SELECT payload, game_updated FROM saves WHERE uid = ?'
    ).bind(info.uid).first();
    if (!row) throw new Error('waffo_save_missing');
    const save = parse(row.payload, null);
    if (!save || save.syncV !== 2) throw new Error('waffo_save_invalid');
    save.tickets = Object.assign({ t1: 0, t10: 0 }, save.tickets || {});
    save.tickets.t1 = Math.max(0, Number(save.tickets.t1) || 0) + info.quantity;
    const gameUpdated = Math.max(Number(row.game_updated || 0) + 1, Date.now(), Number(save.updated || 0) + 1);
    save.updated = Math.max(Number(save.updated) || 0, gameUpdated);
    const payload = JSON.stringify(save);
    const nonce = crypto.randomUUID();
    const now = Date.now();
    try {
      await env.pokesurvivor_data.batch([
        env.pokesurvivor_data.prepare(
          `INSERT OR IGNORE INTO waffo_orders
           (order_id, event_id, uid, product_id, tickets_t1, status, buyer_email,
            merchant_external_id, grant_nonce, payload, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?)`
        ).bind(info.orderId, boundedText(event.id, 128), info.uid,
          boundedText(info.metadata.productId, 128), info.quantity, boundedText(info.metadata.buyerEmail, 200),
          boundedText(info.metadata.orderMerchantExternalId, 128), nonce, JSON.stringify(event), now, now),
        env.pokesurvivor_data.prepare(
          `UPDATE saves SET payload = ?, game_updated = ?, updated_at = ?
           WHERE uid = ? AND game_updated = ? AND payload = ?
             AND EXISTS (SELECT 1 FROM waffo_orders
                         WHERE order_id = ? AND status = 'processing' AND grant_nonce = ?)`
        ).bind(payload, gameUpdated, now, info.uid, Number(row.game_updated || 0), row.payload,
          info.orderId, nonce),
        // Force the D1 batch to roll back if the compare-and-swap did not win.
        env.pokesurvivor_data.prepare(
          `INSERT INTO waffo_grant_guards(id, ok)
           VALUES (?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)`
        ).bind(nonce),
        env.pokesurvivor_data.prepare(
          `UPDATE waffo_orders SET status = 'granted', grant_nonce = NULL,
             granted_at = ?, updated_at = ?
           WHERE order_id = ? AND status = 'processing' AND grant_nonce = ?`
        ).bind(now, now, info.orderId, nonce),
        env.pokesurvivor_data.prepare('DELETE FROM waffo_grant_guards WHERE id = ?').bind(nonce)
      ]);
      return { status: 'granted', tickets: info.quantity };
    } catch (error) {
      // A concurrent game save is normal; retry against the newest payload.
      if (attempt < 2) continue;
      throw error;
    }
  }
  throw new Error('waffo_grant_conflict');
}

async function processWaffoWebhook(env, event) {
  const remembered = await rememberWaffoEvent(env, event);
  if (!remembered.fresh && remembered.status && remembered.status !== 'retry' && remembered.status !== 'processing') {
    return { ok: true, duplicate: true };
  }
  const data = event && event.data || {};
  if (event.mode !== 'prod' || event.storeId !== WAFFO_STORE_ID) {
    await updateWaffoEvent(env, remembered.eventId, 'ignored', { error: 'wrong_store_or_environment' });
    return { ok: true, ignored: true };
  }
  if (event.eventType === 'refund.succeeded') {
    await env.pokesurvivor_data.prepare(
      `UPDATE waffo_orders SET status = 'refund_review', updated_at = ? WHERE order_id = ?`
    ).bind(Date.now(), boundedText(data.orderId, 128)).run();
    await updateWaffoEvent(env, remembered.eventId, 'refund_review', { error: 'refund_requires_manual_review' });
    return { ok: true, refundReview: true };
  }
  if (event.eventType !== 'order.completed') {
    await updateWaffoEvent(env, remembered.eventId, 'ignored', { error: 'event_not_used' });
    return { ok: true, ignored: true };
  }

  const info = waffoMetadata(data);
  if (!info.valid) {
    // This includes old public product links that carry no game UID. We keep
    // the signed event for manual reconciliation instead of guessing an account.
    await updateWaffoEvent(env, remembered.eventId, 'manual_review', { error: 'order_not_bound_to_game_account' });
    return { ok: true, manualReview: true };
  }
  info.metadata.productId = data.productId || '';
  info.metadata.buyerEmail = data.buyerEmail || '';
  info.metadata.orderMerchantExternalId = data.orderMerchantExternalId || '';
  try {
    const result = await grantWaffoPurchase(env, event, info);
    await updateWaffoEvent(env, remembered.eventId, result.status === 'granted' ? 'granted' : 'duplicate', {
      uid: info.uid, tickets: result.tickets
    });
    return { ok: true, [result.status]: true, tickets: result.tickets };
  } catch (error) {
    await updateWaffoEvent(env, remembered.eventId, 'retry', { uid: info.uid, error: error.message });
    throw error;
  }
}

async function waffoWebhookRequest(req, env) {
  const rawBody = await req.text();
  if (!rawBody || rawBody.length > WAFFO_MAX_BODY) return json({ error: 'invalid_webhook' }, 400);
  let event;
  try {
    event = await verifyWaffoWebhook(rawBody, req.headers.get('X-Waffo-Signature'), env);
  } catch (error) {
    console.warn('[waffo-webhook] rejected', error.message);
    return json({ error: 'invalid_webhook' }, 401);
  }
  try {
    return json(await processWaffoWebhook(env, event));
  } catch (error) {
    console.error('[waffo-webhook] retryable error', error);
    return json({ error: 'temporary_webhook_failure' }, 500);
  }
}

async function summary(env, board) {
  const rows = await env.pokesurvivor_data.prepare(
    'SELECT entry_id, payload FROM ranking_entries WHERE board = ? ORDER BY t DESC, entry_id ASC LIMIT ?'
  ).bind(board, TOP).all();
  const top = {};
  for (const row of rows.results || []) top[row.entry_id] = parse(row.payload, {});
  return top;
}

async function rankingEntry(env, board, id) {
  const row = await env.pokesurvivor_data.prepare(
    'SELECT entry_id, payload FROM ranking_entries WHERE board = ? AND entry_id = ?'
  ).bind(board, id).first();
  return row ? { id: row.entry_id, data: parse(row.payload, {}) } : null;
}

async function entriesForUsers(env, board, users) {
  if (!users.length) return [];
  const rows = await env.pokesurvivor_data.prepare(
    'SELECT entry_id, payload FROM ranking_entries WHERE board = ? ORDER BY t DESC LIMIT 500'
  ).bind(board).all();
  return (rows.results || []).map(row => ({ id: row.entry_id, data: parse(row.payload, {}) }))
    .filter(row => (row.data.uids || []).some(x => users.includes(x)));
}

function rankingTrimStatements(env, board) {
  const keep = `SELECT entry_id FROM ranking_entries WHERE board = ? ORDER BY t DESC, entry_id ASC LIMIT ${TOP}`;
  return [
    env.pokesurvivor_data.prepare(
      `DELETE FROM ranking_entry_members
       WHERE board = ? AND entry_id NOT IN (${keep})`
    ).bind(board, board),
    env.pokesurvivor_data.prepare(
      `DELETE FROM ranking_entries
       WHERE board = ? AND entry_id NOT IN (${keep})`
    ).bind(board, board)
  ];
}

async function validateRanking(env, uid, board, id, entry) {
  if (!entry || !id || !board) throw new Error('invalid ranking payload');
  const t = Number(entry.t), lv = Number(entry.lv), kills = Number(entry.kills);
  const uids = Array.isArray(entry.uids) ? entry.uids.map(String) : [];
  const names = Array.isArray(entry.names) ? entry.names : [];
  const dex = Array.isArray(entry.dex) ? entry.dex : [];
  const shiny = Array.isArray(entry.shiny) ? entry.shiny : [];
  if (!Number.isInteger(t) || t <= 0 || t > 21600
      || !Number.isInteger(lv) || lv < 1 || lv > 10 + t / 4
      || !Number.isInteger(kills) || kills < 0 || kills > 100 + t * 12
      || uids.length < 1 || uids.length > 4
      || names.length !== uids.length || dex.length !== uids.length || shiny.length !== uids.length
      || !uids.includes(uid) || new Set(uids).size !== uids.length
      || names.some(v => typeof v !== 'string' || v.length > 40)
      || dex.some(v => !Number.isInteger(Number(v)) || Number(v) < 1 || Number(v) > 1100)
      || shiny.some(v => typeof v !== 'boolean')) throw new Error('invalid ranking payload');
  if (board.startsWith('s_')) {
    if (uids.length !== 1 || id !== uid) throw new Error('invalid ranking id');
  } else if (board.startsWith('g_')) {
    if (uids.length < 2 || id !== uids.join('_')) throw new Error('invalid ranking id');
  } else {
    throw new Error('invalid ranking board');
  }
  const run = await env.pokesurvivor_data.prepare('SELECT payload FROM runs WHERE uid = ?').bind(uid).first();
  const startedAt = Number(parse(run && run.payload, {}).startedAt || 0);
  if (!startedAt || t > Math.floor((Date.now() - startedAt) / 1000) + 15) throw new Error('ranking run not validated');
}

async function storeRanking(env, uid, value) {
  const entry = value && value.entry;
  const id = String(value && value.id || '');
  const boards = Array.isArray(value && value.boards) ? value.boards : [];
  if (!entry || !id || !boards.length || !(entry.uids || []).includes(uid)) throw new Error('invalid ranking payload');
  await validateRanking(env, uid, String(boards[0].board || ''), id, entry);
  const better = [];
  for (const item of boards) {
    const board = String(item.board || '').slice(0, 100), period = String(item.period || '');
    if (!board) continue;
    const old = await env.pokesurvivor_data.prepare('SELECT t FROM ranking_entries WHERE board = ? AND entry_id = ?').bind(board, id).first();
    if (old && Number(old.t) >= Number(entry.t || 0)) continue;
    const topOnly = ['d', 'w', 'm', 'p'].includes(period);
    if (topOnly) {
      // The 50th best row is the cutoff. This stays bounded even if an older
      // database still contains overflow rows from before the trim fix.
      const cutoff = await env.pokesurvivor_data.prepare(
        `SELECT t FROM ranking_entries WHERE board = ? ORDER BY t DESC, entry_id ASC LIMIT 1 OFFSET ${TOP - 1}`
      ).bind(board).first();
      if (cutoff && Number(entry.t || 0) <= Number(cutoff.t || 0)) continue;
    }
    const members = Array.isArray(entry.uids)
      ? [...new Set(entry.uids.map(String))].slice(0, 4)
      : [];
    const statements = [
      env.pokesurvivor_data.prepare(
        `INSERT INTO ranking_entries(board, entry_id, t, payload, updated_at) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(board, entry_id) DO UPDATE SET t=excluded.t, payload=excluded.payload, updated_at=excluded.updated_at
         WHERE excluded.t > ranking_entries.t`
      ).bind(board, id, Number(entry.t || 0), JSON.stringify(entry), Date.now()),
      env.pokesurvivor_data.prepare('DELETE FROM ranking_entry_members WHERE board = ? AND entry_id = ?').bind(board, id),
      ...members.map(member => env.pokesurvivor_data.prepare(
        'INSERT OR IGNORE INTO ranking_entry_members(board, entry_id, uid) VALUES(?, ?, ?)'
      ).bind(board, id, member))
    ];
    if (topOnly) statements.push(...rankingTrimStatements(env, board));
    await env.pokesurvivor_data.batch(statements);
    if (period && period !== 'p' && !better.includes(period)) better.push(period);
  }
  return { better };
}

async function claimShareReward(env, uid, value) {
  const campaign = String(value && value.campaign || '');
  const tickets = Number(SHARE_CAMPAIGNS[campaign] || 0);
  if (!tickets) return { error: 'invalid_campaign', status: 400 };
  const now = Date.now();
  const existing = await env.pokesurvivor_data.prepare(
    'SELECT status, created_at FROM share_rewards WHERE uid = ? AND campaign = ?'
  ).bind(uid, campaign).first();
  if (existing && existing.status === 'claimed') return { ok: true, alreadyClaimed: true, tickets: 0 };
  if (existing && Number(existing.created_at || 0) > now - 10 * 60 * 1000) return { error: 'reward_busy', status: 409 };
  if (existing) await env.pokesurvivor_data.prepare('DELETE FROM share_rewards WHERE uid = ? AND campaign = ?').bind(uid, campaign).run();

  const inserted = await env.pokesurvivor_data.prepare(
    `INSERT OR IGNORE INTO share_rewards(uid, campaign, tickets_t1, status, created_at)
     VALUES(?, ?, ?, 'processing', ?)`
  ).bind(uid, campaign, tickets, now).run();
  if (!inserted.meta || !inserted.meta.changes) return { error: 'reward_busy', status: 409 };

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await env.pokesurvivor_data.prepare('SELECT payload, game_updated FROM saves WHERE uid = ?').bind(uid).first();
      if (!row) return { error: 'sync_required', status: 409 };
      const save = parse(row.payload, null);
      if (!save || typeof save !== 'object') return { error: 'save_invalid', status: 409 };
      save.tickets = save.tickets || { t1: 0, t10: 0 };
      save.tickets.t1 = Math.max(0, Number(save.tickets.t1) || 0) + tickets;
      const gameUpdated = Math.max(Number(row.game_updated || 0) + 1, Date.now());
      save.updated = Math.max(Number(save.updated) || 0, gameUpdated);
      const result = await env.pokesurvivor_data.prepare(
        `UPDATE saves SET payload = ?, game_updated = ?, updated_at = ?
         WHERE uid = ? AND game_updated = ?`
      ).bind(JSON.stringify(save), gameUpdated, Date.now(), uid, Number(row.game_updated || 0)).run();
      if (result.meta && result.meta.changes) {
        await env.pokesurvivor_data.prepare(
          `UPDATE share_rewards SET status = 'claimed', claimed_at = ?
           WHERE uid = ? AND campaign = ? AND status = 'processing'`
        ).bind(Date.now(), uid, campaign).run();
        return { ok: true, alreadyClaimed: false, tickets, save };
      }
    }
    return { error: 'save_busy', status: 409 };
  } finally {
    // A failed grant must be retryable; a claimed row is retained forever.
    const current = await env.pokesurvivor_data.prepare(
      'SELECT status FROM share_rewards WHERE uid = ? AND campaign = ?'
    ).bind(uid, campaign).first();
    if (current && current.status !== 'claimed') {
      await env.pokesurvivor_data.prepare('DELETE FROM share_rewards WHERE uid = ? AND campaign = ?').bind(uid, campaign).run();
    }
  }
}

async function shareRewardStatus(env, uid, value) {
  const campaign = String(value && value.campaign || '');
  if (!Number(SHARE_CAMPAIGNS[campaign] || 0)) return { error: 'invalid_campaign', status: 400 };
  const row = await env.pokesurvivor_data.prepare(
    'SELECT status FROM share_rewards WHERE uid = ? AND campaign = ?'
  ).bind(uid, campaign).first();
  return { ok: true, claimed: !!row && row.status === 'claimed' };
}

// Grants the first-match ticket only from a server-observed online outcome.
// Local bot previews never call this path, and the campaign key makes retries
// and reconnects harmless for the account economy.
async function grantArenaFirstMatchReward(env, uid, matchId, eventType, value = {}) {
  if (!['dead', 'win'].includes(eventType)) return null;
  const now = Date.now();
  const existing = await env.pokesurvivor_data.prepare(
    'SELECT status, created_at FROM arena_reward_claims WHERE uid = ? AND campaign = ?'
  ).bind(uid, ARENA_FIRST_MATCH_CAMPAIGN).first();
  if (existing && existing.status === 'claimed') return { granted: false, alreadyClaimed: true, tickets: 0 };
  if (existing && Number(existing.created_at || 0) > now - 10 * 60 * 1000) return { granted: false, busy: true, tickets: 0 };
  if (existing) await env.pokesurvivor_data.prepare(
    'DELETE FROM arena_reward_claims WHERE uid = ? AND campaign = ?'
  ).bind(uid, ARENA_FIRST_MATCH_CAMPAIGN).run();

  const inserted = await env.pokesurvivor_data.prepare(
    `INSERT OR IGNORE INTO arena_reward_claims
       (uid, campaign, match_id, tickets_t1, status, created_at)
     VALUES (?, ?, ?, ?, 'processing', ?)`
  ).bind(uid, ARENA_FIRST_MATCH_CAMPAIGN, matchId, ARENA_FIRST_MATCH_TICKETS, now).run();
  if (!inserted.meta || !inserted.meta.changes) return { granted: false, busy: true, tickets: 0 };

  let claimed = false;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await env.pokesurvivor_data.prepare(
        'SELECT payload, game_updated FROM saves WHERE uid = ?'
      ).bind(uid).first();
      if (!row) return { granted: false, error: 'sync_required', tickets: 0 };
      const save = parse(row.payload, null);
      if (!save || typeof save !== 'object') return { granted: false, error: 'save_invalid', tickets: 0 };
      save.tickets = Object.assign({ t1: 0, t10: 0 }, save.tickets || {});
      save.tickets.t1 = Math.max(0, Number(save.tickets.t1) || 0) + ARENA_FIRST_MATCH_TICKETS;
      const gameUpdated = Math.max(Number(row.game_updated || 0) + 1, Date.now());
      save.updated = Math.max(Number(save.updated) || 0, gameUpdated);
      const result = await env.pokesurvivor_data.prepare(
        `UPDATE saves SET payload = ?, game_updated = ?, updated_at = ?
         WHERE uid = ? AND game_updated = ?`
      ).bind(JSON.stringify(save), gameUpdated, Date.now(), uid, Number(row.game_updated || 0)).run();
      if (!(result.meta && result.meta.changes)) continue;

      await env.pokesurvivor_data.prepare(
        `UPDATE arena_reward_claims SET status = 'claimed', claimed_at = ?, payload = ?
         WHERE uid = ? AND campaign = ? AND status = 'processing'`
      ).bind(Date.now(), JSON.stringify({ eventType, level: Number(value.level) || 1 }), uid,
        ARENA_FIRST_MATCH_CAMPAIGN).run();
      claimed = true;
      return { granted: true, alreadyClaimed: false, tickets: ARENA_FIRST_MATCH_TICKETS, save };
    }
    return { granted: false, error: 'save_busy', tickets: 0 };
  } finally {
    if (!claimed) await env.pokesurvivor_data.prepare(
      `DELETE FROM arena_reward_claims WHERE uid = ? AND campaign = ? AND status = 'processing'`
    ).bind(uid, ARENA_FIRST_MATCH_CAMPAIGN).run();
  }
}

async function collections(env, uids) {
  if (uids.length) {
    const q = uids.map(() => '?').join(',');
    const rows = await env.pokesurvivor_data.prepare(
      `SELECT c.uid, c.name, c.score, c.owned_count AS ownedCount, c.shiny_count AS shinyCount FROM collections c
       LEFT JOIN account_flags f ON f.uid = c.uid AND f.flag = 'leaderboard_hidden'
       WHERE c.uid IN (${q}) AND f.uid IS NULL
       ORDER BY c.score DESC, c.owned_count DESC, c.shiny_count DESC, c.name COLLATE NOCASE LIMIT ${TOP}`
    ).bind(...uids).all();
    return rows.results || [];
  }
  const rows = await env.pokesurvivor_data.prepare(
    `SELECT c.uid, c.name, c.score, c.owned_count AS ownedCount, c.shiny_count AS shinyCount FROM collections c
     LEFT JOIN account_flags f ON f.uid = c.uid AND f.flag = 'leaderboard_hidden'
     WHERE f.uid IS NULL
     ORDER BY c.score DESC, c.owned_count DESC, c.shiny_count DESC, c.name COLLATE NOCASE LIMIT ${TOP}`
  ).all();
  return rows.results || [];
}

// ---------------- online Arena ----------------

const ARENA_ONLINE = Object.freeze({
  version: 'arena-mvp-online-v2',
  balanceVersion: 'sim-100k-v3',
  mapVersion: 'normal-48-v1',
  entryCoins: 100,
  prizeCoins: 700,
  maxPlayers: 8,
  reconnectMs: 45_000,
  maxDurationSec: 720,
  telemetryMs: 5_000
});
const ARENA_RULES = Object.freeze({
  modeName: 'royal-survival',
  maxPlayers: 8,
  entryCoins: 100,
  winnerPayout: 700,
  ownedLegendaryOnly: true,
  duplicateRoles: 'allowed',
  mapRadiusTiles: 48,
  gasStartSec: 600,
  frenzyStartSec: 660,
  reconnectMs: 45_000,
  ordinaryMonstersOnly: true,
  rifts: false,
  bosses: false,
  timedEvents: false,
  balanceVersion: 'sim-100k-v3'
});
// This is the server-side allowlist for the current 103-role MVP. It keeps a
// modified browser from entering with a non-legendary role or a role that is
// not part of the tested balance table.
const ARENA_LEGENDARY_DEX = new Set([
  144,145,146,149,150,151,243,244,245,248,249,250,251,289,373,376,377,378,
  379,380,381,382,383,384,385,386,445,480,481,482,483,484,485,486,487,488,
  489,490,491,492,493,494,635,638,639,640,641,642,643,644,645,646,647,648,
  649,706,716,717,718,719,720,721,772,773,784,785,786,787,788,789,790,791,
  792,800,801,802,807,808,809,887,888,889,890,891,892,894,895,896,897,898,
  905,998,1004,1005,1006,1007,1009,1010,1015,1016,1017,1018,1024
]);

function arenaId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function arenaInput(value) {
  const v = value && typeof value === 'object' ? value : {};
  const dex = Number(v.dex);
  const name = boundedText(v.name, 40).trim();
  const requestId = /^[A-Za-z0-9_-]{8,80}$/.test(String(v.requestId || ''))
    ? String(v.requestId) : crypto.randomUUID();
  return {
    dex: Number.isInteger(dex) && dex > 0 && dex < 2000 ? dex : 0,
    name: name || 'Jugador',
    shiny: !!v.shiny,
    requestId
  };
}

function arenaRulesJson() { return JSON.stringify(ARENA_RULES); }

async function arenaRecordIncident(env, matchId, uid, kind, severity, payload = {}) {
  const safeKind = boundedText(kind, 60) || 'unknown';
  const safeSeverity = ['info', 'warn', 'high'].includes(severity) ? severity : 'warn';
  const seq = Number(payload.seq) || Math.floor(Date.now() / 1000);
  const dedupeKey = `${matchId}:${uid}:${safeKind}:${seq}`;
  const result = await env.pokesurvivor_data.prepare(
    `INSERT OR IGNORE INTO arena_match_incidents
       (incident_id, match_id, uid, kind, severity, elapsed_sec, dedupe_key, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(arenaId('inc'), matchId, uid, safeKind, safeSeverity,
    Math.max(0, Math.min(ARENA_ONLINE.maxDurationSec, Math.floor(Number(payload.elapsedSec) || 0))),
    dedupeKey, JSON.stringify(payload).slice(0, 4000), Date.now()).run();
  if (result.meta && result.meta.changes) {
    await env.pokesurvivor_data.batch([
      env.pokesurvivor_data.prepare(
        `UPDATE arena_match_players SET anomaly_count = anomaly_count + 1
           WHERE match_id = ? AND uid = ?`
      ).bind(matchId, uid),
      env.pokesurvivor_data.prepare(
        `UPDATE arena_matches SET anomaly_count = anomaly_count + 1 WHERE match_id = ?`
      ).bind(matchId)
    ]);
  }
  return !!(result.meta && result.meta.changes);
}

async function arenaRecordTelemetry(env, matchId, uid, state, elapsedSec, sampleSeq, flags = {}) {
  const now = Date.now();
  const result = await env.pokesurvivor_data.prepare(
    `INSERT OR IGNORE INTO arena_match_telemetry
       (telemetry_id, match_id, uid, sample_seq, elapsed_sec, x, y, hp, max_hp,
        damage_taken, level, kills, damage, pve_kills, skill_casts, flags_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(arenaId('tel'), matchId, uid, sampleSeq,
    Math.max(0, Math.min(ARENA_ONLINE.maxDurationSec, Math.floor(Number(elapsedSec) || 0))),
    Number(state.x) || 0, Number(state.y) || 0, Number(state.hp) || 0,
    Number(state.maxHp) || 1, Number(state.damageTaken) || 0, Number(state.level) || 1,
    Number(state.kills) || 0, Number(state.damage) || 0, Number(state.pveKills) || 0,
    Number(state.skillCasts) || 0, JSON.stringify(flags).slice(0, 1000), now).run();
  if (result.meta && result.meta.changes) {
    await env.pokesurvivor_data.batch([
      env.pokesurvivor_data.prepare(
        `UPDATE arena_match_players SET state_seq = ?, last_state_at = ?, last_x = ?, last_y = ?,
           hp = ?, max_hp = ?, damage_taken = MAX(damage_taken, ?), level = ?,
           state_updates = state_updates + 1, kills = MAX(kills, ?), damage = MAX(damage, ?),
           pve_kills = MAX(pve_kills, ?), skill_casts = MAX(skill_casts, ?)
         WHERE match_id = ? AND uid = ?`
      ).bind(Number(state.seq) || 0, now, Number(state.x) || 0, Number(state.y) || 0,
        Number(state.hp) || 0, Number(state.maxHp) || 1, Number(state.damageTaken) || 0,
        Number(state.level) || 1, Number(state.kills) || 0, Number(state.damage) || 0,
        Number(state.pveKills) || 0, Number(state.skillCasts) || 0, matchId, uid),
      env.pokesurvivor_data.prepare(
        `UPDATE arena_matches SET server_state_updates = server_state_updates + 1,
           peak_active_players = MAX(peak_active_players,
             (SELECT COUNT(*) FROM arena_match_players WHERE match_id = ? AND status IN ('connected','playing')))
         WHERE match_id = ?`
      ).bind(matchId, matchId)
    ]);
  }
  return !!(result.meta && result.meta.changes);
}

async function arenaSnapshot(env, matchId, uid) {
  const match = await env.pokesurvivor_data.prepare(
    `SELECT match_id AS matchId, room_id AS roomId, status, mode_version AS modeVersion,
            balance_version AS balanceVersion, map_version AS mapVersion,
            rules_json AS rulesJson, entry_coins AS entryCoins,
            prize_coins AS prizeCoins, expected_players AS expectedPlayers, seed,
            created_at AS createdAt, started_at AS startedAt, ended_at AS endedAt,
            ended_reason AS endedReason, duration_sec AS durationSec,
            peak_active_players AS peakActivePlayers, server_state_updates AS serverStateUpdates,
            server_actions AS serverActions, anomaly_count AS anomalyCount,
            winner_uid AS winnerUid, settlement_hash AS settlementHash
       FROM arena_matches WHERE match_id = ?`
  ).bind(matchId).first();
  if (!match) return null;
  const rows = await env.pokesurvivor_data.prepare(
    `SELECT uid, seat, name, dex, shiny, status, joined_at AS joinedAt,
            last_seen_at AS lastSeenAt, reconnect_until AS reconnectUntil,
            death_at AS deathAt, kills, damage, damage_taken AS damageTaken,
            pve_kills AS pveKills, skill_casts AS skillCasts, level, hp, max_hp AS maxHp,
            state_seq AS stateSeq, state_updates AS stateUpdates,
            action_count AS actionCount, anomaly_count AS anomalyCount,
            disconnects, reconnects, outcome_rank AS outcomeRank,
            outcome_reason AS outcomeReason
       FROM arena_match_players WHERE match_id = ? ORDER BY seat ASC`
  ).bind(matchId).all();
  const player = (rows.results || []).find(row => row.uid === uid) || null;
  return { match, players: rows.results || [], player };
}

async function arenaCurrent(env, uid) {
  const queued = await env.pokesurvivor_data.prepare(
    `SELECT uid, request_id AS requestId, name, dex, shiny, status,
            match_id AS matchId, queued_at AS queuedAt
       FROM arena_queue WHERE uid = ?`
  ).bind(uid).first();
  if (queued && queued.status === 'queued') {
    const ahead = await env.pokesurvivor_data.prepare(
      `SELECT COUNT(*) AS n FROM arena_queue WHERE status = 'queued' AND queued_at < ?`
    ).bind(queued.queuedAt).first();
    return { status: 'queued', queue: queued, position: Number(ahead && ahead.n || 0) + 1 };
  }
  const player = await env.pokesurvivor_data.prepare(
    `SELECT p.match_id AS matchId, m.status FROM arena_match_players p
       JOIN arena_matches m ON m.match_id = p.match_id
      WHERE p.uid = ? AND m.status IN ('running', 'settling', 'settled')
      ORDER BY m.created_at DESC LIMIT 1`
  ).bind(uid).first();
  if (!player) return { status: 'idle' };
  const snapshot = await arenaSnapshot(env, player.matchId, uid);
  return { status: player.status, ...snapshot };
}

async function arenaAllocate(env) {
  const queued = await env.pokesurvivor_data.prepare(
    `SELECT uid, request_id AS requestId, name, dex, shiny, queued_at AS queuedAt
       FROM arena_queue WHERE status = 'queued' ORDER BY queued_at ASC LIMIT ?`
  ).bind(ARENA_ONLINE.maxPlayers).all();
  const rows = queued.results || [];
  if (rows.length < ARENA_ONLINE.maxPlayers) return null;
  const now = Date.now();
  const matchId = arenaId('am');
  const roomId = arenaId('ar');
  const seed = Math.floor(Math.random() * 0x7fffffff);
  const statements = [env.pokesurvivor_data.prepare(
    `INSERT INTO arena_matches
     (match_id, room_id, status, mode_version, balance_version, map_version, rules_json,
      entry_coins, prize_coins, expected_players, seed, created_at, started_at)
     VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(matchId, roomId, ARENA_ONLINE.version, ARENA_ONLINE.balanceVersion,
    ARENA_ONLINE.mapVersion, arenaRulesJson(), ARENA_ONLINE.entryCoins,
    ARENA_ONLINE.prizeCoins, ARENA_ONLINE.maxPlayers, seed, now, now)];
  rows.forEach((row, seat) => {
    statements.push(env.pokesurvivor_data.prepare(
      `INSERT INTO arena_match_players
       (match_id, uid, seat, name, dex, shiny, entry_coins, status, joined_at, last_seen_at, reconnect_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`
    ).bind(matchId, row.uid, seat, row.name, row.dex, row.shiny ? 1 : 0,
      ARENA_ONLINE.entryCoins, now, now, now + ARENA_ONLINE.reconnectMs));
    statements.push(env.pokesurvivor_data.prepare(
      `UPDATE arena_queue SET status = 'matched', match_id = ?, updated_at = ?
        WHERE uid = ? AND status = 'queued'`
    ).bind(matchId, now, row.uid));
    statements.push(env.pokesurvivor_data.prepare(
      `UPDATE arena_wallet_ledger SET match_id = ?
        WHERE uid = ? AND kind = 'arena_entry' AND idempotency_key = ? AND match_id IS NULL`
    ).bind(matchId, row.uid, `arena-entry:${row.uid}:${row.requestId}`));
  });
  await env.pokesurvivor_data.batch(statements);
  return { matchId, roomId };
}

async function arenaChargeAndQueue(env, uid, value) {
  const current = await arenaCurrent(env, uid);
  // A settled match is history, not a lock: the same account may enter a new
  // match after the previous prize has been recorded.
  if (current.status === 'queued' || (current.match && current.match.status !== 'settled')) return current;
  const input = arenaInput(value);
  if (!ARENA_LEGENDARY_DEX.has(input.dex)) return { error: 'invalid_role', status: 400 };
  const row = await env.pokesurvivor_data.prepare(
    'SELECT payload, game_updated FROM saves WHERE uid = ?'
  ).bind(uid).first();
  const save = row ? parse(row.payload, null) : null;
  if (!save || save.syncV !== 2) return { error: 'save_required', status: 409 };
  if (!save.owned || !save.owned[input.dex]) return { error: 'role_not_owned', status: 403 };
  if (input.shiny && (!save.shiny || !save.shiny[input.dex])) return { error: 'shiny_not_owned', status: 403 };
  // The display name is identity data, not client input.
  input.name = boundedText(save.name, 40).trim() || input.name;
  const coins = Math.floor(Number(save.coins) || 0);
  if (coins < ARENA_ONLINE.entryCoins) return { error: 'coins_insufficient', status: 409 };
  const now = Date.now();
  const gameUpdated = Math.max(now, Number(row.game_updated || 0) + 1);
  const payloadUpdated = Math.max(now, Number(save.updated || 0) + 1);
  const nonce = crypto.randomUUID();
  const ledgerKey = `arena-entry:${uid}:${input.requestId}`;
  try {
    await env.pokesurvivor_data.batch([
      env.pokesurvivor_data.prepare(
        `UPDATE saves SET payload = json_set(payload, '$.coins',
           CAST(json_extract(payload, '$.coins') AS INTEGER) - ?, '$.updated', ?),
           game_updated = ?, updated_at = ?
         WHERE uid = ? AND game_updated = ? AND payload = ?
           AND CAST(json_extract(payload, '$.coins') AS INTEGER) >= ?`
      ).bind(ARENA_ONLINE.entryCoins, payloadUpdated, gameUpdated, now, uid,
        Number(row.game_updated || 0), row.payload, ARENA_ONLINE.entryCoins),
      env.pokesurvivor_data.prepare(
        `INSERT INTO arena_wallet_guards(id, ok) VALUES (?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)`
      ).bind(nonce),
      env.pokesurvivor_data.prepare(
        `INSERT INTO arena_wallet_ledger
         (ledger_id, uid, match_id, kind, amount, idempotency_key, created_at, payload)
         VALUES (?, ?, NULL, 'arena_entry', ?, ?, ?, ?)`
      ).bind(nonce, uid, -ARENA_ONLINE.entryCoins, ledgerKey, now,
        JSON.stringify({ version: ARENA_ONLINE.version, requestId: input.requestId, dex: input.dex })),
      // arena_queue is keyed by uid. Once a previous match is settled, its
      // matched queue row is historical and must not block the next entry.
      env.pokesurvivor_data.prepare(
        `DELETE FROM arena_queue WHERE uid = ? AND status = 'matched'`
      ).bind(uid),
      env.pokesurvivor_data.prepare(
        `INSERT INTO arena_queue(uid, request_id, name, dex, shiny, status, queued_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`
      ).bind(uid, input.requestId, input.name, input.dex, input.shiny ? 1 : 0, now, now),
      env.pokesurvivor_data.prepare('DELETE FROM arena_wallet_guards WHERE id = ?').bind(nonce)
    ]);
  } catch (error) {
    // A duplicate request is safe: the existing queue/match is returned on
    // the next call. Any failed CAS rolls back both the charge and ledger.
    const retry = await arenaCurrent(env, uid);
    if (retry.status !== 'idle') return retry;
    throw error;
  }
  await arenaAllocate(env);
  return arenaCurrent(env, uid);
}

async function arenaRefundQueued(env, uid) {
  const queued = await env.pokesurvivor_data.prepare(
    `SELECT request_id AS requestId FROM arena_queue WHERE uid = ? AND status = 'queued'`
  ).bind(uid).first();
  if (!queued) return arenaCurrent(env, uid);
  const row = await env.pokesurvivor_data.prepare(
    'SELECT payload, game_updated FROM saves WHERE uid = ?'
  ).bind(uid).first();
  if (!row) return { error: 'save_required', status: 409 };
  const now = Date.now(), nonce = crypto.randomUUID();
  const gameUpdated = Math.max(now, Number(row.game_updated || 0) + 1);
  const key = `arena-refund:${uid}:${queued.requestId}`;
  await env.pokesurvivor_data.batch([
    env.pokesurvivor_data.prepare(
      `UPDATE saves SET payload = json_set(payload, '$.coins',
         CAST(json_extract(payload, '$.coins') AS INTEGER) + ?, '$.updated', ?),
         game_updated = ?, updated_at = ?
       WHERE uid = ? AND game_updated = ? AND payload = ?`
    ).bind(ARENA_ONLINE.entryCoins, now, gameUpdated, now, uid, Number(row.game_updated || 0), row.payload),
    env.pokesurvivor_data.prepare(
      `INSERT INTO arena_wallet_guards(id, ok) VALUES (?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)`
    ).bind(nonce),
    env.pokesurvivor_data.prepare(
      `INSERT INTO arena_wallet_ledger
       (ledger_id, uid, match_id, kind, amount, idempotency_key, created_at, payload)
       VALUES (?, ?, NULL, 'arena_refund', ?, ?, ?, ?)`
    ).bind(nonce, uid, ARENA_ONLINE.entryCoins, key, now, JSON.stringify({ version: ARENA_ONLINE.version })),
    env.pokesurvivor_data.prepare('DELETE FROM arena_queue WHERE uid = ? AND status = \'queued\'').bind(uid),
    env.pokesurvivor_data.prepare('DELETE FROM arena_wallet_guards WHERE id = ?').bind(nonce)
  ]);
  return { status: 'idle', refunded: ARENA_ONLINE.entryCoins };
}

async function arenaTrySettle(env, matchId, reason = 'elimination') {
  const active = await env.pokesurvivor_data.prepare(
    `SELECT uid, status, kills, damage FROM arena_match_players
      WHERE match_id = ? AND status IN ('connected', 'playing') ORDER BY seat ASC`
  ).bind(matchId).all();
  const activeRows = active.results || [];
  if (activeRows.length !== 1) return { settled: false, pending: true, active: activeRows.length };
  const winner = activeRows[0];
  const match = await env.pokesurvivor_data.prepare(
    `SELECT prize_coins AS prizeCoins, status, started_at AS startedAt
       FROM arena_matches WHERE match_id = ?`
  ).bind(matchId).first();
  if (!match) return { error: 'match_not_found', status: 404 };
  if (match.status === 'settled') return { settled: true, winnerUid: winner.uid };
  const all = await env.pokesurvivor_data.prepare(
    `SELECT uid, seat, status, death_at AS deathAt, kills, damage
       FROM arena_match_players WHERE match_id = ? ORDER BY seat ASC`
  ).bind(matchId).all();
  const allRows = all.results || [];
  const rankRows = allRows.slice().sort((a, b) => {
    if (a.uid === winner.uid) return -1;
    if (b.uid === winner.uid) return 1;
    const statusRank = value => value === 'dead' ? 0 : value === 'withdrawn' ? -1 : -2;
    return statusRank(b.status) - statusRank(a.status)
      || (Number(b.deathAt) || 0) - (Number(a.deathAt) || 0)
      || (Number(b.kills) || 0) - (Number(a.kills) || 0)
      || (Number(b.damage) || 0) - (Number(a.damage) || 0)
      || Number(a.seat) - Number(b.seat);
  });
  const now = Date.now();
  const durationSec = Math.max(0, Math.floor((now - Number(match.startedAt || now)) / 1000));
  const saveRow = await env.pokesurvivor_data.prepare(
    'SELECT payload, game_updated FROM saves WHERE uid = ?'
  ).bind(winner.uid).first();
  const save = saveRow ? parse(saveRow.payload, null) : null;
  if (!save || save.syncV !== 2) return { settled: false, pending: true, error: 'winner_save_unavailable' };
  const nonce = crypto.randomUUID();
  const gameUpdated = Math.max(now, Number(saveRow.game_updated || 0) + 1);
  const payloadUpdated = Math.max(now, Number(save.updated || 0) + 1);
  const hashSource = `${matchId}:${winner.uid}:${reason}:${rankRows.map(row => `${row.uid}:${row.status}:${row.kills}:${row.damage}`).join('|')}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashSource));
  const settlementHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const statements = [
    env.pokesurvivor_data.prepare(
      `UPDATE saves SET payload = json_set(payload, '$.coins',
         CAST(json_extract(payload, '$.coins') AS INTEGER) + ?, '$.updated', ?),
         game_updated = ?, updated_at = ?
       WHERE uid = ? AND game_updated = ? AND payload = ?`
    ).bind(Number(match.prizeCoins) || ARENA_ONLINE.prizeCoins, payloadUpdated, gameUpdated, now,
      winner.uid, Number(saveRow.game_updated || 0), saveRow.payload),
    env.pokesurvivor_data.prepare(
      `INSERT INTO arena_wallet_guards(id, ok) VALUES (?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)`
    ).bind(nonce),
    env.pokesurvivor_data.prepare(
      `INSERT INTO arena_wallet_ledger
       (ledger_id, uid, match_id, kind, amount, idempotency_key, created_at, payload)
       VALUES (?, ?, ?, 'arena_prize', ?, ?, ?, ?)`
    ).bind(nonce, winner.uid, matchId, Number(match.prizeCoins) || ARENA_ONLINE.prizeCoins,
      `arena-prize:${matchId}`, now, JSON.stringify({ version: ARENA_ONLINE.version, settlementHash })),
    env.pokesurvivor_data.prepare(
      `UPDATE arena_matches SET status = 'settled', ended_at = ?, ended_reason = ?,
         duration_sec = ?, winner_uid = ?, settlement_hash = ?
       WHERE match_id = ? AND status != 'settled'`
    ).bind(now, boundedText(reason, 40) || 'elimination', durationSec, winner.uid, settlementHash, matchId)
  ];
  rankRows.forEach((row, index) => {
    statements.push(env.pokesurvivor_data.prepare(
      `UPDATE arena_match_players SET status = CASE WHEN uid = ? THEN 'won' ELSE status END,
          outcome_rank = ?, outcome_reason = ?
        WHERE match_id = ? AND uid = ?`
    ).bind(winner.uid, index + 1, row.uid === winner.uid ? 'winner' : (row.status || 'eliminated'), matchId, row.uid));
  });
  statements.push(env.pokesurvivor_data.prepare('DELETE FROM arena_wallet_guards WHERE id = ?').bind(nonce));
  try {
    await env.pokesurvivor_data.batch(statements);
  } catch (error) {
    const settled = await env.pokesurvivor_data.prepare(
      'SELECT status, winner_uid AS winnerUid, settlement_hash AS settlementHash FROM arena_matches WHERE match_id = ?'
    ).bind(matchId).first();
    if (settled && settled.status === 'settled') return { settled: true, ...settled };
    throw error;
  }
  return { settled: true, winnerUid: winner.uid, settlementHash, reason };
}

async function arenaReport(env, uid, value) {
  const v = value && typeof value === 'object' ? value : {};
  const matchId = String(v.matchId || '');
  const eventId = /^[A-Za-z0-9_-]{8,80}$/.test(String(v.eventId || '')) ? String(v.eventId) : crypto.randomUUID();
  const eventType = ['state', 'dead', 'win', 'withdrawn'].includes(String(v.eventType)) ? String(v.eventType) : '';
  const elapsedSec = Math.max(0, Math.min(ARENA_ONLINE.maxDurationSec, Math.floor(Number(v.elapsedSec) || 0)));
  const level = Math.max(1, Math.min(200, Math.floor(Number(v.level) || 1)));
  const kills = Math.max(0, Math.min(7, Math.floor(Number(v.kills) || 0)));
  const damage = Math.max(0, Math.min(1e8, Number(v.damage) || 0));
  const damageTaken = Math.max(0, Math.min(1e8, Number(v.damageTaken) || 0));
  const pveKills = Math.max(0, Math.min(100000, Math.floor(Number(v.pveKills) || 0)));
  const skillCasts = Math.max(0, Math.min(100000, Math.floor(Number(v.skillCasts) || 0)));
  if (!/^am_[A-Za-z0-9]{20,64}$/.test(matchId) || !eventType) return { error: 'invalid_arena_report', status: 400 };
  const player = await env.pokesurvivor_data.prepare(
    `SELECT p.status AS playerStatus, m.status AS matchStatus FROM arena_match_players p
       JOIN arena_matches m ON m.match_id = p.match_id
      WHERE p.match_id = ? AND p.uid = ?`
  ).bind(matchId, uid).first();
  if (!player) return { error: 'arena_player_not_found', status: 404 };
  if (player.matchStatus === 'settled') return arenaSnapshot(env, matchId, uid);
  if (eventType === 'win' && ['dead', 'withdrawn'].includes(player.playerStatus)) return { error: 'player_eliminated', status: 409 };
  const now = Date.now();
  await env.pokesurvivor_data.batch([
    env.pokesurvivor_data.prepare(
      `INSERT OR IGNORE INTO arena_match_events
       (event_id, match_id, uid, event_type, elapsed_sec, level, kills, damage, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(eventId, matchId, uid, eventType, elapsedSec, level, kills, damage, JSON.stringify(v).slice(0, 4000), now),
    env.pokesurvivor_data.prepare(
      `UPDATE arena_match_players SET
         status = CASE WHEN ? = 'dead' THEN 'dead' WHEN ? = 'withdrawn' THEN 'withdrawn'
                       WHEN status = 'reserved' THEN 'playing' ELSE status END,
         last_seen_at = ?, death_at = CASE WHEN ? IN ('dead','withdrawn') THEN ? ELSE death_at END,
         kills = MAX(kills, ?), damage = MAX(damage, ?),
         damage_taken = MAX(damage_taken, ?), pve_kills = MAX(pve_kills, ?),
         skill_casts = MAX(skill_casts, ?)
       WHERE match_id = ? AND uid = ?`
    ).bind(eventType, eventType, now, eventType, now, kills, damage,
      damageTaken, pveKills, skillCasts, matchId, uid)
  ]);
  const reward = await grantArenaFirstMatchReward(env, uid, matchId, eventType, { level });
  const settlement = eventType === 'dead' || eventType === 'withdrawn' || eventType === 'win'
    ? await arenaTrySettle(env, matchId, eventType === 'win' ? 'win' : eventType) : { settled: false };
  return { ok: true, matchId, eventId, reward, settlement, ...(await arenaSnapshot(env, matchId, uid)) };
}

async function handle(req, env, uid, url) {
  const path = url.pathname.replace(/^\/v1\/?/, '').replace(/\/$/, '');
  const method = req.method;

  if (path === 'waffo/checkout' && method === 'POST') {
    try {
      const result = await createWaffoCheckout(env, uid, await readBody(req) || {});
      return json(result, result.status || 200);
    } catch (error) {
      console.error('[waffo-checkout]', error);
      const status = error.code === 'waffo_not_configured' ? 503 :
        error.code === 'waffo_api_error' ? 502 : 500;
      return json({ error: error.code || 'checkout_unavailable' }, status);
    }
  }

  if (path === 'arena/match' && method === 'GET') {
    const matchId = String(url.searchParams.get('matchId') || '');
    if (!/^am_[A-Za-z0-9]{20,64}$/.test(matchId)) return json({ error: 'invalid_match' }, 400);
    const snapshot = await arenaSnapshot(env, matchId, uid);
    if (!snapshot) return json({ error: 'arena_match_not_found' }, 404);
    if (!snapshot.player) return json({ error: 'arena_player_not_found' }, 403);
    return json(snapshot);
  }

  if (path === 'arena/report' && method === 'POST') {
    const result = await arenaReport(env, uid, await readBody(req) || {});
    return json(result, result.status || 200);
  }

  if (path === 'save') {
    if (method === 'GET') return json(await saveState(env, uid));
    if (method === 'PUT') {
      const value = await readBody(req);
      if (!value || !value.save || JSON.stringify(value.save).length > 900000) return json({ error: 'invalid save' }, 400);
      if (value.save.syncV === 2) {
        if (!Object.hasOwn(value, 'baseVersion') ||
            !(value.baseVersion === null || /^[a-f0-9]{64}$/.test(value.baseVersion)))
          return json({ error: 'version_required' }, 400);
        const version = await savePutV2(env, uid, value.save, value.baseVersion);
        return version ? json({ ok: true, version }) : json({ error: 'save_conflict' }, 409);
      }
      return await savePut(env, uid, value.save) ? json({ ok: true }) : json({ error: 'save_conflict' }, 409);
    }
    if (method === 'DELETE') {
      await env.pokesurvivor_data.prepare('DELETE FROM saves WHERE uid = ?').bind(uid).run(); return json({ ok: true });
    }
  }

  if (path === 'run') {
    if (method === 'PUT') {
      const value = await readBody(req) || {};
      const run = { startedAt: Date.now(), mode: String(value.mode || '').slice(0, 20) };
      await env.pokesurvivor_data.prepare(
        'INSERT INTO runs(uid, payload, updated_at) VALUES(?, ?, ?) ON CONFLICT(uid) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at'
      ).bind(uid, JSON.stringify(run), Date.now()).run(); return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.pokesurvivor_data.prepare('DELETE FROM runs WHERE uid = ?').bind(uid).run(); return json({ ok: true });
    }
  }

  if (path === 'arena-feedback' && method === 'PUT') {
    const value = await readBody(req) || {};
    const allowedLiked = new Set(['yes', 'mixed', 'no']);
    const allowedOutcome = new Set(['win', 'loss']);
    const feedbackId = /^[A-Za-z0-9_-]{8,80}$/.test(String(value.feedbackId || ''))
      ? String(value.feedbackId) : crypto.randomUUID();
    const arenaVersion = boundedText(value.arenaVersion, 40) || 'arena-mvp-coins-v1';
    const runCount = Math.max(0, Math.min(9999, Math.floor(Number(value.runCount) || 0)));
    const liked = allowedLiked.has(String(value.liked)) ? String(value.liked) : '';
    const likedPoints = Array.isArray(value.likedPoints)
      ? value.likedPoints.map(v => boundedText(v, 32)).filter(Boolean).slice(0, 2).join('|')
      : boundedText(value.likedPoints, 80);
    const dislikedPoint = boundedText(value.dislikedPoint, 40);
    const suggestion = boundedText(value.suggestion, 240);
    const outcome = allowedOutcome.has(String(value.outcome)) ? String(value.outcome) : '';
    const durationSec = Math.max(0, Math.min(3600, Math.floor(Number(value.durationSec) || 0)));
    const level = Math.max(0, Math.min(999, Math.floor(Number(value.level) || 0)));
    const roleDex = Math.max(0, Math.min(9999, Math.floor(Number(value.roleDex) || 0)));
    if (!liked || !runCount || !outcome) return json({ error: 'invalid_feedback' }, 400);
    await env.pokesurvivor_data.prepare(
      `INSERT OR IGNORE INTO arena_feedback
       (feedback_id, uid, arena_version, run_count, liked, liked_points, disliked_point, suggestion, outcome, duration_sec, level, role_dex, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(feedbackId, uid, arenaVersion, runCount, liked, likedPoints, dislikedPoint,
      suggestion, outcome, durationSec, level, roleDex, Date.now()).run();
    return json({ ok: true, feedbackId });
  }

  if (path === 'collection') {
    if (method === 'GET') {
      const uids = (url.searchParams.get('uids') || '').split(',').filter(Boolean).slice(0, 30);
      return json({ rows: await collections(env, uids) });
    }
    if (method === 'PUT') {
      const value = await readBody(req) || {};
      const saveRow = await env.pokesurvivor_data.prepare('SELECT payload FROM saves WHERE uid = ?').bind(uid).first();
      const save = saveRow ? parse(saveRow.payload, null) : null;
      if (!save || save.syncV !== 2) return json({ error: 'save_required' }, 409);
      const serverOwnedCount = objectKeyCount(save.owned);
      const serverShinyCount = objectKeyCount(save.shiny);
      const ownedCount = Number(value.ownedCount);
      const shinyCount = Number(value.shinyCount);
      const score = Number(value.score);
      // Counts must come from the server save. Shiny is allowed to be lower
      // than the raw save count because the client excludes unsupported shiny
      // sprites, but it can never be higher than the save itself.
      const maxScore = serverOwnedCount * 25 + Math.max(0, Math.min(serverShinyCount, shinyCount)) * 50;
      if (!Number.isSafeInteger(ownedCount) || ownedCount < 0 || ownedCount !== serverOwnedCount ||
          !Number.isSafeInteger(shinyCount) || shinyCount < 0 || shinyCount > serverShinyCount ||
          !Number.isSafeInteger(score) || score < 0 || score > maxScore) {
        return json({ error: 'collection_mismatch' }, 409);
      }
      // Quarantined accounts keep their save and can continue playing, but
      // cannot reappear in public collection rankings until reviewed.
      if (await leaderboardHidden(env, uid)) return json({ ok: true, hidden: true });
      const row = { uid, name: String(value.name || '???').slice(0, 32), score,
        ownedCount, shinyCount };
      await env.pokesurvivor_data.prepare(
        `INSERT INTO collections(uid, name, score, owned_count, shiny_count, payload, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET name=excluded.name, score=excluded.score, owned_count=excluded.owned_count, shiny_count=excluded.shiny_count, payload=excluded.payload, updated_at=excluded.updated_at`
      ).bind(uid, row.name, row.score, row.ownedCount, row.shinyCount, JSON.stringify(row), Date.now()).run(); return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.pokesurvivor_data.prepare('DELETE FROM collections WHERE uid = ?').bind(uid).run(); return json({ ok: true });
    }
  }

  if (path === 'ranking/summary' && method === 'GET') {
    const board = String(url.searchParams.get('board') || '').slice(0, 100);
    const top = await summary(env, board);
    return json({ top, hasData: Object.keys(top).length > 0 });
  }
  if (path === 'ranking/entry' && method === 'GET') {
    const board = String(url.searchParams.get('board') || '').slice(0, 100);
    const id = String(url.searchParams.get('id') || '').slice(0, 300);
    return json({ entry: await rankingEntry(env, board, id) });
  }
  if (path === 'ranking/users' && method === 'POST') {
    const value = await readBody(req) || {};
    const board = String(value.board || '').slice(0, 100);
    const users = Array.isArray(value.uids) ? value.uids.slice(0, 30).map(String) : [];
    return json({ entries: await entriesForUsers(env, board, users) });
  }
  if (path === 'ranking/count' && method === 'GET') {
    const board = String(url.searchParams.get('board') || '').slice(0, 100), t = Number(url.searchParams.get('t') || 0);
    const row = await env.pokesurvivor_data.prepare('SELECT COUNT(*) AS n FROM ranking_entries WHERE board = ? AND t > ?').bind(board, t).first();
    return json({ count: Number(row && row.n || 0) });
  }
  if (path === 'ranking/store' && method === 'POST') {
    try { return json(await storeRanking(env, uid, await readBody(req))); }
    catch (e) { return json({ error: e.message || 'invalid ranking payload' }, 400); }
  }
  if (path === 'ranking/remove' && method === 'DELETE') {
    await env.pokesurvivor_data.batch([
      env.pokesurvivor_data.prepare(
        `DELETE FROM ranking_entries
         WHERE (board, entry_id) IN (
           SELECT board, entry_id FROM ranking_entry_members WHERE uid = ?
         )`
      ).bind(uid),
      env.pokesurvivor_data.prepare('DELETE FROM ranking_entry_members WHERE uid = ?').bind(uid)
    ]);
    return json({ ok: true });
  }

  if (path === 'rewards/share' && method === 'GET') {
    const campaign = url.searchParams.get('campaign') || '';
    const result = await shareRewardStatus(env, uid, { campaign });
    return result.error ? json({ error: result.error }, result.status || 400) : json(result);
  }
  if (path === 'rewards/share' && method === 'POST') {
    const result = await claimShareReward(env, uid, await readBody(req));
    return result.error ? json({ error: result.error }, result.status || 400) : json(result);
  }

  if (path === 'profile') {
    if (method === 'GET') {
      const target = url.searchParams.get('uid') || uid;
      const row = await env.pokesurvivor_data.prepare('SELECT payload FROM profiles WHERE uid = ?').bind(target).first();
      return json({ profile: row ? parse(row.payload, null) : null });
    }
    if (method === 'PUT') {
      const value = await readBody(req) || {}, name = String(value.name || '').slice(0, 32), lower = String(value.lower || name).toLowerCase();
      await env.pokesurvivor_data.prepare(
        `INSERT INTO profiles(uid, name, lower, payload, updated_at) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET name=excluded.name, lower=excluded.lower, payload=excluded.payload, updated_at=excluded.updated_at`
      ).bind(uid, name, lower, JSON.stringify({ ...value, name, lower }), Date.now()).run(); return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.pokesurvivor_data.prepare('DELETE FROM profiles WHERE uid = ?').bind(uid).run(); return json({ ok: true });
    }
  }

  if (path === 'name') {
    const lower = String(url.searchParams.get('lower') || '').toLowerCase().slice(0, 64);
    if (method === 'GET') {
      const row = await env.pokesurvivor_data.prepare('SELECT uid FROM names WHERE lower = ?').bind(lower).first(); return json({ name: row || null });
    }
    if (method === 'PUT') {
      try {
        await env.pokesurvivor_data.prepare('INSERT INTO names(lower, uid, updated_at) VALUES(?, ?, ?)').bind(lower, uid, Date.now()).run(); return json({ ok: true });
      } catch (e) {
        const row = await env.pokesurvivor_data.prepare('SELECT uid FROM names WHERE lower = ?').bind(lower).first(); return json({ error: 'taken', uid: row && row.uid }, 409);
      }
    }
    if (method === 'DELETE') {
      await env.pokesurvivor_data.prepare('DELETE FROM names WHERE lower = ? AND uid = ?').bind(lower, uid).run(); return json({ ok: true });
    }
  }

  if (path === 'friendships') {
    if (method === 'GET') {
      const rows = await env.pokesurvivor_data.prepare('SELECT payload FROM friendships WHERE from_uid = ? OR to_uid = ? ORDER BY updated_at DESC').bind(uid, uid).all();
      return json({ friendships: (rows.results || []).map(r => parse(r.payload, {})) });
    }
    if (method === 'PUT' || method === 'PATCH') {
      const value = await readBody(req) || {}, users = Array.isArray(value.users) ? value.users.map(String).sort() : [];
      if (users.length !== 2 || !users.includes(uid)) return json({ error: 'users' }, 400);
      const id = String(value.id || users[0] + '_' + users[1]), names = value.names || {};
      await env.pokesurvivor_data.prepare(
        `INSERT INTO friendships(id, users_json, from_uid, to_uid, status, names_json, payload, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET users_json=excluded.users_json, from_uid=excluded.from_uid, to_uid=excluded.to_uid, status=excluded.status, names_json=excluded.names_json, payload=excluded.payload, updated_at=excluded.updated_at`
      ).bind(id, JSON.stringify(users), users[0], users[1], String(value.status || 'pending'), JSON.stringify(names), JSON.stringify({ ...value, id, users, names }), Date.now()).run(); return json({ ok: true });
    }
    if (method === 'DELETE') {
      const id = String(url.searchParams.get('id') || ''), row = await env.pokesurvivor_data.prepare('SELECT users_json FROM friendships WHERE id = ?').bind(id).first();
      if (row && parse(row.users_json, []).includes(uid)) await env.pokesurvivor_data.prepare('DELETE FROM friendships WHERE id = ?').bind(id).run(); return json({ ok: true });
    }
  }

  if (path === 'invites') {
    if (method === 'GET') {
      const rows = await env.pokesurvivor_data.prepare('SELECT id, payload FROM invites WHERE to_uid = ?').bind(uid).all();
      return json({ invites: (rows.results || []).map(r => ({ id: r.id, ...parse(r.payload, {}) })) });
    }
    if (method === 'PUT') {
      const value = await readBody(req) || {}, to = String(value.to || ''), from = String(value.from || uid);
      if (from !== uid || !to) return json({ error: 'invite' }, 400);
      const id = String(value.id || to + '_' + from);
      await env.pokesurvivor_data.prepare('INSERT INTO invites(id, to_uid, from_uid, payload, updated_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at').bind(id, to, from, JSON.stringify({ ...value, id }), Date.now()).run(); return json({ ok: true });
    }
    if (method === 'DELETE') {
      const id = String(url.searchParams.get('id') || ''); await env.pokesurvivor_data.prepare('DELETE FROM invites WHERE id = ? AND (to_uid = ? OR from_uid = ?)').bind(id, uid, uid).run(); return json({ ok: true });
    }
  }

  if (path === 'presence') {
    if (method === 'GET') {
      const users = (url.searchParams.get('uids') || '').split(',').filter(Boolean).slice(0, 30);
      if (!users.length) return json({ presence: [] });
      const q = users.map(() => '?').join(','), rows = await env.pokesurvivor_data.prepare(`SELECT uid, payload FROM presence WHERE uid IN (${q})`).bind(...users).all();
      return json({ presence: (rows.results || []).map(r => ({ uid: r.uid, ...parse(r.payload, {}) })) });
    }
    if (method === 'PUT') {
      const value = await readBody(req) || {};
      await env.pokesurvivor_data.prepare('INSERT INTO presence(uid, payload, updated_at) VALUES(?, ?, ?) ON CONFLICT(uid) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at').bind(uid, JSON.stringify(value), Date.now()).run(); return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.pokesurvivor_data.prepare('DELETE FROM presence WHERE uid = ?').bind(uid).run(); return json({ ok: true });
    }
  }

  if (path === 'account' && method === 'DELETE') {
    await env.pokesurvivor_data.batch([
      env.pokesurvivor_data.prepare('DELETE FROM saves WHERE uid = ?').bind(uid),
      env.pokesurvivor_data.prepare('DELETE FROM runs WHERE uid = ?').bind(uid),
      env.pokesurvivor_data.prepare('DELETE FROM collections WHERE uid = ?').bind(uid),
      env.pokesurvivor_data.prepare('DELETE FROM profiles WHERE uid = ?').bind(uid),
      env.pokesurvivor_data.prepare('DELETE FROM names WHERE uid = ?').bind(uid),
      env.pokesurvivor_data.prepare('DELETE FROM presence WHERE uid = ?').bind(uid),
      env.pokesurvivor_data.prepare('DELETE FROM arena_feedback WHERE uid = ?').bind(uid),
      env.pokesurvivor_data.prepare('DELETE FROM arena_reward_claims WHERE uid = ?').bind(uid),
      env.pokesurvivor_data.prepare('DELETE FROM share_rewards WHERE uid = ?').bind(uid),
      env.pokesurvivor_data.prepare('DELETE FROM arena_queue WHERE uid = ?').bind(uid),
      env.pokesurvivor_data.prepare('DELETE FROM arena_match_events WHERE uid = ?').bind(uid),
      env.pokesurvivor_data.prepare('DELETE FROM arena_match_players WHERE uid = ?').bind(uid),
      env.pokesurvivor_data.prepare('DELETE FROM arena_wallet_ledger WHERE uid = ?').bind(uid),
      env.pokesurvivor_data.prepare('DELETE FROM invites WHERE to_uid = ? OR from_uid = ?').bind(uid, uid),
      env.pokesurvivor_data.prepare('DELETE FROM friendships WHERE from_uid = ? OR to_uid = ?').bind(uid, uid),
      env.pokesurvivor_data.prepare(
        `DELETE FROM ranking_entries
         WHERE (board, entry_id) IN (
           SELECT board, entry_id FROM ranking_entry_members WHERE uid = ?
         )`
      ).bind(uid),
      env.pokesurvivor_data.prepare('DELETE FROM ranking_entry_members WHERE uid = ?').bind(uid)
    ]);
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

// ---------------- ephemeral multiplayer rooms ----------------

// The queue is a singleton Durable Object on purpose: one serialized queue
// means a burst of 160 clicks is deterministically split into 20 groups of 8.
export class ArenaMatchmaker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ready = state.blockConcurrencyWhile(async () => {});
  }

  async fetch(req) {
    await this.ready;
    return this.state.blockConcurrencyWhile(async () => {
      const uid = req.headers.get('X-PS-UID') || '';
      if (!uid) return json({ error: 'unauthorized' }, 401);
      const env = this.env;
      if (!env) return json({ error: 'arena_unavailable' }, 503);
      if (req.method === 'POST') return json(await arenaChargeAndQueue(env, uid, await readBody(req) || {}));
      if (req.method === 'GET') return json(await arenaCurrent(env, uid));
      if (req.method === 'DELETE') return json(await arenaRefundQueued(env, uid));
      return json({ error: 'method_not_allowed' }, 405);
    });
  }
}

function arenaSafeState(value) {
  const v = value && typeof value === 'object' ? value : {};
  const number = (n, min, max) => Number.isFinite(Number(n)) ? Math.max(min, Math.min(max, Number(n))) : 0;
  return {
    seq: Math.max(0, Math.floor(number(v.seq, 0, 1e9))),
    x: number(v.x, -5000, 5000), y: number(v.y, -5000, 5000),
    hp: number(v.hp, 0, 1e7), maxHp: number(v.maxHp, 1, 1e7),
    damageTaken: number(v.damageTaken, 0, 1e8),
    level: Math.floor(number(v.level, 1, 200)),
    kills: Math.floor(number(v.kills, 0, 7)), damage: number(v.damage, 0, 1e8),
    pveKills: Math.floor(number(v.pveKills, 0, 100000)),
    skillCasts: Math.floor(number(v.skillCasts, 0, 100000)),
    dead: !!v.dead, at: Date.now()
  };
}

function arenaSafeAction(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    seq: Math.max(0, Math.min(1e9, Math.floor(Number(v.seq) || 0))),
    move: String(v.move || '').slice(0, 40),
    aim: Math.max(-Math.PI * 2, Math.min(Math.PI * 2, Number(v.aim) || 0)),
    at: Date.now()
  };
}

// The browser owns presentation and input latency, but the room rejects
// impossible state jumps before relaying them. This is intentionally
// conservative: a dead player cannot resurrect, counters only move forward,
// and suspicious corrections are retained as incidents for later review.
function arenaValidatedState(value, previous) {
  const next = arenaSafeState(value);
  if (!previous) return { state: next, incidents: [] };
  if (next.seq <= previous.seq) return { state: null, incidents: [] };
  const incidents = [];
  const elapsed = Math.max(0.05, (Date.now() - Number(previous.at || 0)) / 1000);
  const maxStep = 260 * elapsed + 80;
  const dx = next.x - previous.x, dy = next.y - previous.y;
  const distance = Math.hypot(dx, dy);
  if (distance > maxStep) {
    if (distance > maxStep * 1.75) {
      incidents.push({ kind: 'movement_jump', severity: 'warn', payload: {
        seq: next.seq, distance: Math.round(distance), maxStep: Math.round(maxStep)
      } });
    }
    const scale = maxStep / distance;
    next.x = previous.x + dx * scale;
    next.y = previous.y + dy * scale;
  }
  if (next.maxHp > previous.maxHp * 1.5 && next.maxHp - previous.maxHp > 50) {
    incidents.push({ kind: 'max_hp_jump', severity: 'high', payload: {
      seq: next.seq, previous: previous.maxHp, received: next.maxHp
    } });
  }
  if (next.hp > previous.hp + Math.max(250, previous.maxHp * 0.75)) {
    incidents.push({ kind: 'hp_jump', severity: 'warn', payload: {
      seq: next.seq, previous: previous.hp, received: next.hp
    } });
  }
  if (next.level > previous.level + 5) {
    incidents.push({ kind: 'level_jump', severity: 'warn', payload: {
      seq: next.seq, previous: previous.level, received: next.level
    } });
  }
  if (next.kills > previous.kills + 3) {
    incidents.push({ kind: 'kill_counter_jump', severity: 'warn', payload: {
      seq: next.seq, previous: previous.kills, received: next.kills
    } });
  }
  next.maxHp = previous.maxHp;
  next.hp = previous.dead ? 0 : Math.min(next.hp, next.maxHp);
  next.level = Math.max(previous.level, next.level);
  next.kills = Math.max(previous.kills, next.kills);
  next.damage = Math.max(previous.damage, next.damage);
  next.damageTaken = Math.max(previous.damageTaken || 0, next.damageTaken);
  next.pveKills = Math.max(previous.pveKills || 0, next.pveKills);
  next.skillCasts = Math.max(previous.skillCasts || 0, next.skillCasts);
  next.dead = !!previous.dead || !!next.dead;
  return { state: next, incidents };
}

export class ArenaRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.matchId = '';
    this.sockets = new Map();
    this.socketUids = new Map();
    this.pending = new Set();
    this.latest = {};
    this.actionSeq = new Map();
    this.actionAt = new Map();
    this.telemetryAt = new Map();
    this.telemetrySeq = new Map();
    this.startedAt = 0;
    this.ready = state.blockConcurrencyWhile(async () => {
      this.latest = await state.storage.get('latest') || {};
      this.matchId = await state.storage.get('matchId') || '';
    });
  }

  send(socket, value) { try { socket.send(JSON.stringify(value)); } catch (e) { /* disconnected */ } }

  broadcast(value, except = '') {
    for (const [uid, socket] of this.sockets) if (uid !== except) this.send(socket, value);
  }

  async snapshot(env) {
    const snapshot = await arenaSnapshot(env, this.matchId, '');
    if (snapshot) snapshot.latest = this.latest;
    return snapshot;
  }

  async touch(env, uid, status = 'connected', reconnect = false) {
    await env.pokesurvivor_data.prepare(
      `UPDATE arena_match_players SET status = CASE WHEN status IN ('dead','withdrawn') THEN status ELSE ? END,
          last_seen_at = ?, reconnect_until = ?, reconnects = reconnects + ?
        WHERE match_id = ? AND uid = ?`
    ).bind(status, Date.now(), Date.now() + ARENA_ONLINE.reconnectMs, reconnect ? 1 : 0, this.matchId, uid).run();
  }

  async fetch(req) {
    await this.ready;
    this.matchId = req.headers.get('X-PS-MATCH') || this.matchId;
    if (this.matchId) await this.state.storage.put('matchId', this.matchId);
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'websocket required' }, 426);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.pending.add(server);
    server.addEventListener('message', event => this.message(server, event.data).catch(error => {
      console.error('[arena-room]', error);
      this.send(server, { type: 'error', error: 'arena_room_error' });
    }));
    server.addEventListener('close', () => this.disconnect(server).catch(() => {}));
    this.state.storage.setAlarm(Date.now() + 15000);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'ps-v1' } });
  }

  async message(socket, raw) {
    let value;
    try { value = JSON.parse(raw); } catch (e) { return; }
    if (!value || typeof value.type !== 'string') return;
    let uid = this.socketUids.get(socket) || '';
    if (!uid) {
      if (value.type !== 'auth' || typeof value.token !== 'string') {
        this.send(socket, { type: 'auth', ok: false, error: 'unauthorized' });
        try { socket.close(4003, 'unauthorized'); } catch (e) { /* nada */ }
        return;
      }
      uid = await verify(value.token);
      if (!uid) {
        this.send(socket, { type: 'auth', ok: false, error: 'unauthorized' });
        try { socket.close(4003, 'unauthorized'); } catch (e) { /* nada */ }
        return;
      }
      this.pending.delete(socket);
      const old = this.sockets.get(uid);
      if (old && old !== socket) { this.socketUids.delete(old); try { old.close(4001, 'replaced'); } catch (e) { /* nada */ } }
      this.sockets.set(uid, socket);
      this.socketUids.set(socket, uid);
      this.send(socket, { type: 'auth', ok: true });
      return;
    }
    const env = this.env;
    if (!env) return;
    if (value.type === 'join') {
      const row = await env.pokesurvivor_data.prepare(
        `SELECT p.status, p.reconnect_until AS reconnectUntil, m.status AS matchStatus,
                m.started_at AS startedAt
           FROM arena_match_players p JOIN arena_matches m ON m.match_id = p.match_id
          WHERE p.match_id = ? AND p.uid = ?`
      ).bind(this.matchId, uid).first();
      if (!row || !['running', 'settling', 'settled'].includes(row.matchStatus)) return this.send(socket, { type: 'error', error: 'arena_match_not_found' });
      if (row.status === 'dead') return this.send(socket, { type: 'error', error: 'player_eliminated' });
      if (row.status === 'withdrawn' || Number(row.reconnectUntil) < Date.now()) {
        if (row.status !== 'withdrawn') {
          await env.pokesurvivor_data.prepare(
            `UPDATE arena_match_players SET status = 'withdrawn', death_at = ?, last_seen_at = ?, reconnect_until = 0
              WHERE match_id = ? AND uid = ? AND status IN ('reserved', 'connected', 'playing')`
          ).bind(Date.now(), Date.now(), this.matchId, uid).run();
          await arenaTrySettle(env, this.matchId, 'reconnect_expired');
        }
        return this.send(socket, { type: 'error', error: 'reconnect_expired' });
      }
      this.startedAt = Number(row.startedAt) || this.startedAt || Date.now();
      const isReconnect = row.status === 'connected' || row.status === 'playing';
      await this.touch(env, uid, row.status === 'dead' ? 'dead' : 'connected', isReconnect);
      const snapshot = await this.snapshot(env);
      this.send(socket, { type: 'arena', match: snapshot });
      this.broadcast({ type: 'arena', match: snapshot }, uid);
      return;
    }
    const player = await env.pokesurvivor_data.prepare(
      'SELECT 1 AS ok FROM arena_match_players WHERE match_id = ? AND uid = ?'
    ).bind(this.matchId, uid).first();
    if (!player) return this.send(socket, { type: 'error', error: 'arena_player_not_found' });
    if (value.type === 'heartbeat') { await this.touch(env, uid); return; }
    if (value.type === 'state') {
      const previous = this.latest[uid];
      const audit = arenaValidatedState(value.state, previous);
      const state = audit.state;
      if (!state) return;
      const becameDead = state.dead && !previous?.dead;
      this.latest[uid] = { uid, ...state };
      await this.state.storage.put('latest', this.latest);
      await this.touch(env, uid, state.dead ? 'dead' : 'playing');
      const elapsedSec = Math.floor(Math.max(0, (Date.now() - Number(this.startedAt || Date.now())) / 1000));
      for (const incident of audit.incidents) {
        await arenaRecordIncident(env, this.matchId, uid, incident.kind, incident.severity,
          Object.assign({}, incident.payload, { elapsedSec }));
      }
      const now = Date.now();
      if (now - (this.telemetryAt.get(uid) || 0) >= ARENA_ONLINE.telemetryMs) {
        const sampleSeq = (this.telemetrySeq.get(uid) || 0) + 1;
        this.telemetryAt.set(uid, now);
        this.telemetrySeq.set(uid, sampleSeq);
        await arenaRecordTelemetry(env, this.matchId, uid, state, elapsedSec, sampleSeq, {
          gas: elapsedSec >= ARENA_RULES.gasStartSec,
          frenzy: elapsedSec >= ARENA_RULES.frenzyStartSec,
          corrected: audit.incidents.length > 0
        });
      }
      if (becameDead) {
        await arenaReport(env, uid, {
          matchId: this.matchId,
          eventType: 'dead',
          eventId: arenaId('state_dead'),
          elapsedSec,
          level: state.level,
          kills: state.kills,
          damage: state.damage,
          damageTaken: state.damageTaken,
          pveKills: state.pveKills,
          skillCasts: state.skillCasts
        });
      }
      this.broadcast({ type: 'state', state: this.latest[uid] }, uid);
      return;
    }
    if (value.type === 'action') {
      const action = arenaSafeAction(value.action);
      const previousSeq = this.actionSeq.get(uid) || 0;
      const now = Date.now();
      if (action.seq <= previousSeq || now - (this.actionAt.get(uid) || 0) < 70) return;
      this.actionSeq.set(uid, action.seq);
      this.actionAt.set(uid, now);
      await env.pokesurvivor_data.batch([
        env.pokesurvivor_data.prepare(
          `UPDATE arena_match_players SET action_count = action_count + 1,
             skill_casts = skill_casts + 1 WHERE match_id = ? AND uid = ?`
        ).bind(this.matchId, uid),
        env.pokesurvivor_data.prepare(
          `UPDATE arena_matches SET server_actions = server_actions + 1 WHERE match_id = ?`
        ).bind(this.matchId)
      ]);
      this.broadcast({ type: 'action', uid, action }, uid);
      return;
    }
    if (value.type === 'leave') {
      const result = await arenaReport(env, uid, { matchId: this.matchId, eventType: 'withdrawn', elapsedSec: 0, eventId: arenaId('leave') });
      // An explicit leave is a forfeit, not a transient network disconnect.
      // Clear the reconnect lease so a user cannot leave and re-enter the same
      // paid match to scout or duplicate a settlement.
      await env.pokesurvivor_data.prepare(
        `UPDATE arena_match_players SET reconnect_until = 0
          WHERE match_id = ? AND uid = ? AND status = 'withdrawn'`
      ).bind(this.matchId, uid).run();
      if (result && result.match) this.broadcast({ type: 'arena', match: result }, '');
      try { socket.close(1000, 'left'); } catch (e) { /* nada */ }
      return;
    }
    if (value.type === 'report') {
      const result = await arenaReport(env, uid, Object.assign({}, value.report || {}, { matchId: this.matchId }));
      this.send(socket, { type: 'report', result });
      if (result && result.match) this.broadcast({ type: 'arena', match: result }, '');
    }
  }

  async disconnect(socket) {
    this.pending.delete(socket);
    const uid = this.socketUids.get(socket);
    if (!uid || this.sockets.get(uid) !== socket) return;
    this.sockets.delete(uid); this.socketUids.delete(socket);
    if (this.env && this.matchId) {
      await this.env.pokesurvivor_data.prepare(
        `UPDATE arena_match_players SET disconnects = disconnects + 1, last_seen_at = ?
          WHERE match_id = ? AND uid = ? AND status NOT IN ('dead','withdrawn')`
      ).bind(Date.now(), this.matchId, uid).run();
    }
    if (this.sockets.size === 0) this.state.storage.setAlarm(Date.now() + 15000);
  }

  async alarm() {
    const env = this.env;
    if (!env || !this.matchId) return;
    const now = Date.now();
    await env.pokesurvivor_data.prepare(
      `UPDATE arena_match_players SET status = 'withdrawn', death_at = ?, last_seen_at = ?
        WHERE match_id = ? AND status IN ('reserved','connected','playing') AND reconnect_until < ?`
    ).bind(now, now, this.matchId, now).run();
    const match = await env.pokesurvivor_data.prepare(
      'SELECT status, started_at AS startedAt FROM arena_matches WHERE match_id = ?'
    ).bind(this.matchId).first();
    if (match && match.status === 'running') {
      // A disconnected or cheating client must never keep a paid room alive
      // forever. The browser still renders the 10:00 gas + 60 second frenzy,
      // while this server-side cutoff provides the final authoritative guard.
      if (Number(match.startedAt) && now >= Number(match.startedAt) + ARENA_ONLINE.maxDurationSec * 1000) {
        const rows = await env.pokesurvivor_data.prepare(
          `SELECT uid, seat, status FROM arena_match_players
             WHERE match_id = ? AND status IN ('connected', 'playing') ORDER BY seat ASC`
        ).bind(this.matchId).all();
        const active = rows.results || [];
        if (active.length) {
          const score = row => {
            const latest = this.latest[row.uid] || {};
            const hp = Number(latest.hp), maxHp = Math.max(1, Number(latest.maxHp) || 1);
            return [latest.dead ? 0 : 1, Number.isFinite(hp) ? hp / maxHp : 0,
              Number(latest.level) || 1, Number(latest.kills) || 0,
              Number(latest.damage) || 0, -Number(row.seat)];
          };
          active.sort((a, b) => {
            const aa = score(a), bb = score(b);
            for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return bb[i] - aa[i];
            return 0;
          });
          await env.pokesurvivor_data.batch(active.map((row, index) => env.pokesurvivor_data.prepare(
            `UPDATE arena_match_players SET status = ?, death_at = CASE WHEN ? = 'dead' THEN ? ELSE death_at END,
                last_seen_at = ? WHERE match_id = ? AND uid = ? AND status IN ('connected', 'playing')`
          ).bind(index === 0 ? 'playing' : 'dead', index === 0 ? 'playing' : 'dead', now, now, this.matchId, row.uid)));
        }
      }
      await arenaTrySettle(env, this.matchId, 'timeout');
      this.state.storage.setAlarm(Date.now() + 15000);
    }
  }
}

function roomMember(uid, value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    uid,
    name: String(v.name || '').slice(0, 40),
    dex: Number.isInteger(Number(v.dex)) ? Number(v.dex) : 0,
    shiny: !!v.shiny,
    at: Number(v.at) || Date.now(),
    seen: Date.now()
  };
}

export class Room {
  constructor(state) {
    this.state = state;
    this.room = null;
    this.sockets = new Map();
    this.socketUids = new Map();
    this.pending = new Set();
    this.ready = state.blockConcurrencyWhile(async () => {
      this.room = await state.storage.get('room') || null;
      this.prune(Date.now());
    });
  }

  async fetch(req) {
    await this.ready;
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'websocket required' }, 426);
    const uid = req.headers.get('X-PS-UID') || '';
    const roomId = req.headers.get('X-PS-ROOM') || '';
    const protocols = (req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(v => v.trim()).filter(Boolean);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    if (uid) {
      const old = this.sockets.get(uid);
      if (old) { this.socketUids.delete(old); try { old.close(4001, 'replaced'); } catch (e) { /* nada */ } }
      this.sockets.set(uid, server);
      this.socketUids.set(server, uid);
    } else this.pending.add(server);
    this.roomId = roomId;
    server.addEventListener('message', event => this.message(server, event.data).catch(error => {
      console.error('[room]', error);
      try { server.send(JSON.stringify({ type: 'error', error: 'room_error' })); } catch (e) { /* nada */ }
    }));
    server.addEventListener('close', () => this.disconnectSocket(server).catch(() => {}));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': protocols.includes('ps-v1') ? 'ps-v1' : protocols[0] || 'ps-v1' }
    });
  }

  prune(now) {
    if (!this.room) return;
    for (const [uid, member] of Object.entries(this.room.members || {})) {
      if (!this.sockets.has(uid) && now - Number(member.seen || 0) > 45000) delete this.room.members[uid];
    }
    if (!this.room.members[this.room.host]) this.room = null;
  }

  async save() {
    if (this.room) await this.state.storage.put('room', this.room);
    else await this.state.storage.delete('room');
  }

  publicRoom() {
    if (!this.room) return null;
    const members = Object.values(this.room.members || {}).map(({ seen, ...member }) => member)
      .sort((a, b) => a.uid === this.room.host ? -1 : b.uid === this.room.host ? 1 : (a.at || 0) - (b.at || 0));
    return { id: this.room.id, host: this.room.host, open: !!this.room.open, members };
  }

  send(socket, value) { try { socket.send(JSON.stringify(value)); } catch (e) { /* disconnected */ } }

  broadcast(value, except) {
    for (const [uid, socket] of this.sockets) if (uid !== except) this.send(socket, value);
  }

  async message(socket, raw) {
    let value;
    try { value = JSON.parse(raw); } catch (e) { return; }
    if (!value || typeof value.type !== 'string') return;
    let uid = this.socketUids.get(socket) || '';
    if (!uid) {
      if (value.type !== 'auth' || typeof value.token !== 'string') {
        this.send(socket, { type: 'auth', ok: false, error: 'unauthorized' });
        try { socket.close(4003, 'unauthorized'); } catch (e) { /* nada */ }
        return;
      }
      uid = await verify(value.token);
      if (!uid) {
        this.send(socket, { type: 'auth', ok: false, error: 'unauthorized' });
        try { socket.close(4003, 'unauthorized'); } catch (e) { /* nada */ }
        return;
      }
      const old = this.sockets.get(uid);
      if (old && old !== socket) {
        this.socketUids.delete(old);
        try { old.close(4001, 'replaced'); } catch (e) { /* nada */ }
      }
      this.pending.delete(socket);
      this.sockets.set(uid, socket);
      this.socketUids.set(socket, uid);
      this.send(socket, { type: 'auth', ok: true });
      return;
    }
    const now = Date.now();
    this.prune(now);
    if (value.type === 'join') {
      if (!this.room) {
        if (!value.create) return this.send(socket, { type: 'error', error: 'room_not_found' });
        this.room = { id: this.roomId || uid + '_' + now.toString(36), host: uid, open: true, members: {} };
      }
      if (this.room.host !== uid && !this.room.open && !this.room.members[uid]) return this.send(socket, { type: 'error', error: 'room_closed' });
      if (!this.room.members[uid] && Object.keys(this.room.members).length >= 4) return this.send(socket, { type: 'error', error: 'room_full' });
      this.room.members[uid] = roomMember(uid, value.member);
      await this.save();
      this.broadcast({ type: 'room', room: this.publicRoom() }, uid);
      this.send(socket, { type: 'room', room: this.publicRoom() });
      return;
    }
    if (!this.room || !this.room.members[uid]) return this.send(socket, { type: 'error', error: 'not_in_room' });
    if (value.type === 'heartbeat') {
      this.room.members[uid].seen = now;
      return;
    }
    if (value.type === 'relay') {
      const target = String(value.to || '');
      if (target && this.sockets.has(target) && value.env && typeof value.env === 'object') this.send(this.sockets.get(target), { type: 'relay', from: uid, env: value.env });
      return;
    }
    if (value.type === 'set-open') {
      if (uid !== this.room.host) return;
      this.room.open = !!value.open;
      await this.save();
      this.broadcast({ type: 'room', room: this.publicRoom() });
      return;
    }
    if (value.type === 'member') {
      const old = this.room.members[uid];
      this.room.members[uid] = Object.assign(old, roomMember(uid, Object.assign({}, old, value.member || {})), { seen: now });
      await this.save();
      this.broadcast({ type: 'room', room: this.publicRoom() });
      return;
    }
    if (value.type === 'leave') return this.disconnect(uid, socket, true);
  }

  async disconnect(uid, socket, explicit = false) {
    if (this.sockets.get(uid) !== socket) { this.socketUids.delete(socket); return; }
    this.sockets.delete(uid);
    this.socketUids.delete(socket);
    if (!this.room || !this.room.members[uid]) return;
    if (uid === this.room.host) {
      this.broadcast({ type: 'closed', reason: explicit ? 'left' : 'host_left' }, uid);
      for (const other of this.sockets.values()) { try { other.close(4000, 'room closed'); } catch (e) { /* nada */ } }
      this.sockets.clear(); this.room = null; await this.save(); return;
    }
    delete this.room.members[uid];
    if (!Object.keys(this.room.members).length) { this.room = null; await this.save(); return; }
    await this.save();
    this.broadcast({ type: 'room', room: this.publicRoom() });
  }

  async disconnectSocket(socket, explicit = false) {
    this.pending.delete(socket);
    const uid = this.socketUids.get(socket);
    if (!uid) return;
    return this.disconnect(uid, socket, explicit);
  }
}

function websocketToken(req, url) {
  const protocols = (req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(v => v.trim()).filter(Boolean);
  return protocols[1] || url.searchParams.get('token') || '';
}

export default {
  async fetch(req, env) {
    const headers = cors(req.headers.get('Origin') || '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'pokesurvivor-data' }, 200, headers);
    if (url.pathname === '/v1/waffo/webhook' && req.method === 'POST') {
      return waffoWebhookRequest(req, env);
    }
    if (url.pathname === '/v1/arena/ws' && (req.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      const matchId = url.searchParams.get('match') || '';
      if (!/^am_[A-Za-z0-9]{20,64}$/.test(matchId)) return json({ error: 'arena_match' }, 400, headers);
      const token = websocketToken(req, url);
      const uid = token ? await verify(token) : '';
      if (token && !uid) return json({ error: 'unauthorized' }, 401, headers);
      const h = new Headers(req.headers);
      h.set('X-PS-UID', uid); h.set('X-PS-MATCH', matchId);
      const stub = env.ARENA_ROOMS.get(env.ARENA_ROOMS.idFromName(matchId));
      return stub.fetch(new Request(req, { headers: h }));
    }
    if (url.pathname === '/v1/room/ws' && (req.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      const roomId = url.searchParams.get('room') || '';
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(roomId)) return json({ error: 'room' }, 400, headers);
      const token = websocketToken(req, url);
      const uid = token ? await verify(token) : '';
      if (token && !uid) return json({ error: 'unauthorized' }, 401, headers);
      const h = new Headers(req.headers);
      h.set('X-PS-UID', uid); h.set('X-PS-ROOM', roomId);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      return stub.fetch(new Request(req, { headers: h }));
    }
    const uid = await verify((req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
    if (!uid) return json({ error: 'unauthorized' }, 401, headers);
    try {
      if (url.pathname === '/v1/arena/queue') {
        const h = new Headers(req.headers);
        h.set('X-PS-UID', uid);
        const stub = env.ARENA_MATCHMAKER.get(env.ARENA_MATCHMAKER.idFromName('global'));
        const response = await stub.fetch(new Request(req, { headers: h }));
        Object.entries(headers).forEach(([k, v]) => response.headers.set(k, v));
        return response;
      }
      const response = await handle(req, env, uid, url);
      Object.entries(headers).forEach(([k, v]) => response.headers.set(k, v));
      return response;
    } catch (e) {
      console.error('[data-worker]', e);
      return json({ error: 'server error' }, 500, headers);
    }
  }
};
