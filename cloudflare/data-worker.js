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
const SHARE_CAMPAIGN = 'share_t1_5_v1';
const SHARE_TICKETS = 5;
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
  const row = await env.pokesurvivor_data.prepare('SELECT payload, game_updated FROM saves WHERE uid = ?').bind(uid).first();
  if (row) {
    const current = parse(row.payload, null);
    if (!current || current.syncV !== 2 || baseVersion !== await saveVersion(row.payload, row.game_updated)) return null;
  } else if (baseVersion !== null) return null;

  const payload = JSON.stringify(value);
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
    if (['d', 'w', 'm', 'p'].includes(period)) {
      const full = await env.pokesurvivor_data.prepare('SELECT COUNT(*) AS n, MIN(t) AS min_t FROM ranking_entries WHERE board = ?').bind(board).first();
      if (Number(full && full.n) >= TOP && Number(entry.t || 0) <= Number(full.min_t || 0)) continue;
    }
    await env.pokesurvivor_data.prepare(
      `INSERT INTO ranking_entries(board, entry_id, t, payload, updated_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(board, entry_id) DO UPDATE SET t=excluded.t, payload=excluded.payload, updated_at=excluded.updated_at
       WHERE excluded.t > ranking_entries.t`
    ).bind(board, id, Number(entry.t || 0), JSON.stringify(entry), Date.now()).run();
    if (period && period !== 'p' && !better.includes(period)) better.push(period);
  }
  return { better };
}

async function claimShareReward(env, uid, value) {
  const campaign = String(value && value.campaign || '');
  if (campaign !== SHARE_CAMPAIGN) return { error: 'invalid_campaign', status: 400 };
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
  ).bind(uid, campaign, SHARE_TICKETS, now).run();
  if (!inserted.meta || !inserted.meta.changes) return { error: 'reward_busy', status: 409 };

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await env.pokesurvivor_data.prepare('SELECT payload, game_updated FROM saves WHERE uid = ?').bind(uid).first();
      if (!row) return { error: 'sync_required', status: 409 };
      const save = parse(row.payload, null);
      if (!save || typeof save !== 'object') return { error: 'save_invalid', status: 409 };
      save.tickets = save.tickets || { t1: 0, t10: 0 };
      save.tickets.t1 = Math.max(0, Number(save.tickets.t1) || 0) + SHARE_TICKETS;
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
        return { ok: true, alreadyClaimed: false, tickets: SHARE_TICKETS, save };
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
  if (campaign !== SHARE_CAMPAIGN) return { error: 'invalid_campaign', status: 400 };
  const row = await env.pokesurvivor_data.prepare(
    'SELECT status FROM share_rewards WHERE uid = ? AND campaign = ?'
  ).bind(uid, campaign).first();
  return { ok: true, claimed: !!row && row.status === 'claimed' };
}

async function collections(env, uids) {
  if (uids.length) {
    const q = uids.map(() => '?').join(',');
    const rows = await env.pokesurvivor_data.prepare(
      `SELECT uid, name, score, owned_count AS ownedCount, shiny_count AS shinyCount FROM collections
       WHERE uid IN (${q}) ORDER BY score DESC, owned_count DESC, shiny_count DESC, name COLLATE NOCASE LIMIT ${TOP}`
    ).bind(...uids).all();
    return rows.results || [];
  }
  const rows = await env.pokesurvivor_data.prepare(
    `SELECT uid, name, score, owned_count AS ownedCount, shiny_count AS shinyCount FROM collections
     ORDER BY score DESC, owned_count DESC, shiny_count DESC, name COLLATE NOCASE LIMIT ${TOP}`
  ).all();
  return rows.results || [];
}

async function handle(req, env, uid, url) {
  const path = url.pathname.replace(/^\/v1\/?/, '').replace(/\/$/, '');
  const method = req.method;

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

  if (path === 'collection') {
    if (method === 'GET') {
      const uids = (url.searchParams.get('uids') || '').split(',').filter(Boolean).slice(0, 30);
      return json({ rows: await collections(env, uids) });
    }
    if (method === 'PUT') {
      const value = await readBody(req) || {};
      const row = { uid, name: String(value.name || '???').slice(0, 32), score: Number(value.score || 0) | 0,
        ownedCount: Number(value.ownedCount || 0) | 0, shinyCount: Number(value.shinyCount || 0) };
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
    await env.pokesurvivor_data.prepare(
      `DELETE FROM ranking_entries
       WHERE EXISTS (SELECT 1 FROM json_each(json_extract(payload, '$.uids')) WHERE value = ?)`
    ).bind(uid).run();
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
      env.pokesurvivor_data.prepare('DELETE FROM invites WHERE to_uid = ? OR from_uid = ?').bind(uid, uid),
      env.pokesurvivor_data.prepare('DELETE FROM friendships WHERE from_uid = ? OR to_uid = ?').bind(uid, uid),
      env.pokesurvivor_data.prepare(`DELETE FROM ranking_entries WHERE EXISTS (SELECT 1 FROM json_each(json_extract(payload, '$.uids')) WHERE value = ?)`).bind(uid)
    ]);
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

// ---------------- ephemeral multiplayer rooms ----------------

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
      const response = await handle(req, env, uid, url);
      Object.entries(headers).forEach(([k, v]) => response.headers.set(k, v));
      return response;
    } catch (e) {
      console.error('[data-worker]', e);
      return json({ error: 'server error' }, 500, headers);
    }
  }
};
