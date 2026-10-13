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

async function savePut(env, uid, value) {
  const now = Date.now();
  const gameUpdated = Math.floor(Number(value && value.updated) || 0);
  await env.pokesurvivor_data.prepare(
    `INSERT INTO saves(uid, payload, game_updated, updated_at) VALUES(?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET payload=excluded.payload, game_updated=excluded.game_updated, updated_at=excluded.updated_at
     WHERE excluded.game_updated >= saves.game_updated`
  ).bind(uid, JSON.stringify(value || {}), gameUpdated, now).run();
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

async function storeRanking(env, uid, value) {
  const entry = value && value.entry;
  const id = String(value && value.id || '');
  const boards = Array.isArray(value && value.boards) ? value.boards : [];
  if (!entry || !id || !boards.length || !(entry.uids || []).includes(uid)) throw new Error('invalid ranking payload');
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
    if (method === 'GET') return json({ save: await saveGet(env, uid) });
    if (method === 'PUT') {
      const value = await readBody(req);
      if (!value || !value.save || JSON.stringify(value.save).length > 900000) return json({ error: 'invalid save' }, 400);
      await savePut(env, uid, value.save); return json({ ok: true });
    }
    if (method === 'DELETE') {
      await env.pokesurvivor_data.prepare('DELETE FROM saves WHERE uid = ?').bind(uid).run(); return json({ ok: true });
    }
  }

  if (path === 'run') {
    if (method === 'PUT') {
      const value = await readBody(req) || {};
      await env.pokesurvivor_data.prepare(
        'INSERT INTO runs(uid, payload, updated_at) VALUES(?, ?, ?) ON CONFLICT(uid) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at'
      ).bind(uid, JSON.stringify(value), Date.now()).run(); return json({ ok: true });
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

export default {
  async fetch(req, env) {
    const headers = cors(req.headers.get('Origin') || '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'pokesurvivor-data' }, 200, headers);
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
