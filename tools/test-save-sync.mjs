import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import worker from '../cloudflare/data-worker.js';

class MemoryD1 {
  constructor() { this.rows = new Map(); }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async first() {
            const row = db.rows.get(args[0]);
            if (!row) return null;
            if (sql.includes('game_updated')) return { payload: row.payload, game_updated: row.game_updated };
            return { payload: row.payload };
          },
          async run() {
            const uid = sql.startsWith('UPDATE saves') ? args[3] : args[0];
            const row = db.rows.get(uid);
            let changes = 0;
            if (sql.startsWith('INSERT OR IGNORE')) {
              if (!row) { db.rows.set(uid, { payload: args[1], game_updated: args[2], updated_at: args[3] }); changes = 1; }
            } else if (sql.startsWith('UPDATE saves')) {
              if (row && row.game_updated === args[4] && row.payload === args[5]) {
                db.rows.set(uid, { payload: args[0], game_updated: args[1], updated_at: args[2] }); changes = 1;
              }
            } else if (sql.startsWith('INSERT INTO saves')) {
              const next = { payload: args[1], game_updated: args[2], updated_at: args[3] };
              if (!row || (row.game_updated <= args[2] && JSON.parse(row.payload).syncV !== 2)) {
                db.rows.set(uid, next); changes = 1;
              }
            } else throw new Error('Unexpected SQL: ' + sql);
            return { meta: { changes } };
          }
        };
      }
    };
  }
}

const uid = 'test-user';
const now = Math.floor(Date.now() / 1000);
const pair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']
);
const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'sync-test' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const unsigned = encode({ alg: 'RS256', kid: jwk.kid }) + '.' + encode({
  aud: 'pokesurvivor-xyz', iss: 'https://securetoken.google.com/pokesurvivor-xyz',
  sub: uid, iat: now - 10, exp: now + 3600
});
const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(unsigned));
const token = unsigned + '.' + Buffer.from(signature).toString('base64url');
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
  if (String(url).includes('service_accounts/v1/jwk')) return Response.json({ keys: [jwk] });
  throw new Error('Unexpected external request: ' + url);
};

const db = new MemoryD1();
const env = { pokesurvivor_data: db };
async function call(method, body, binding = env) {
  const response = await worker.fetch(new Request('https://api.pokesurvivor.xyz/v1/save', {
    method, headers: { Authorization: 'Bearer ' + token, Origin: 'https://pokesurvivor.xyz' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), binding);
  return { status: response.status, data: await response.json() };
}

test('new save is acknowledged only after insertion and has a server version', async () => {
  const empty = await call('GET');
  assert.deepEqual(empty.data, { save: null, version: null, protocol: 2 });
  const first = await call('PUT', { save: { syncV: 2, name: 'New', updated: 1, coins: 500 }, baseVersion: null });
  assert.equal(first.status, 200);
  assert.match(first.data.version, /^[a-f0-9]{64}$/);
  assert.equal((await call('GET')).data.save.name, 'New');
});

test('concurrent and legacy clients cannot overwrite a versioned save', async () => {
  const base = (await call('GET')).data.version;
  const update = await call('PUT', { save: { syncV: 2, name: 'New', updated: 2, coins: 600 }, baseVersion: base });
  assert.equal(update.status, 200);
  assert.notEqual(update.data.version, base);
  assert.equal((await call('PUT', { save: { syncV: 2, name: 'New', updated: 3, coins: 200 }, baseVersion: base })).status, 409);
  assert.equal((await call('PUT', { save: { name: 'Old client', updated: Date.now() + 100000, coins: 0 } })).status, 409);
  assert.equal((await call('GET')).data.save.coins, 600);
});

test('payment or reward payload changes invalidate an old version even if its timestamp does not advance', async () => {
  const base = (await call('GET')).data.version;
  const row = db.rows.get(uid);
  const granted = { ...JSON.parse(row.payload), tickets: { t1: 10, t10: 0 } };
  row.payload = JSON.stringify(granted);
  assert.equal((await call('PUT', { save: { ...granted, tickets: { t1: 0, t10: 0 } }, baseVersion: base })).status, 409);
  const current = (await call('GET')).data;
  const next = await call('PUT', { save: { ...current.save, updated: 1 }, baseVersion: current.version });
  assert.equal(next.status, 200);
  assert.equal((await call('GET')).data.save.tickets.t1, 10);
});

test('missing version is rejected rather than silently accepted', async () => {
  const result = await call('PUT', { save: { syncV: 2, name: 'New' } });
  assert.equal(result.status, 400);
  assert.equal(result.data.error, 'version_required');
});

test('the legacy-write guard and versioned CAS work in real SQLite', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE saves(uid TEXT PRIMARY KEY, payload TEXT NOT NULL, game_updated INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
  const binding = { pokesurvivor_data: { prepare(sql) { return { bind(...args) { return {
    async first() { return sqlite.prepare(sql).get(...args) || null; },
    async run() { return { meta: { changes: sqlite.prepare(sql).run(...args).changes } }; }
  }; } }; } } };
  const initial = await call('PUT', { save: { syncV: 2, name: 'SQLite', updated: 1, coins: 500 }, baseVersion: null }, binding);
  assert.equal(initial.status, 200);
  assert.equal((await call('PUT', { save: { name: 'Old tab', updated: Date.now() + 1e6 } }, binding)).status, 409);
  const newer = await call('PUT', { save: { syncV: 2, name: 'SQLite', updated: 2, coins: 600 }, baseVersion: initial.data.version }, binding);
  assert.equal(newer.status, 200);
  assert.equal((await call('PUT', { save: { syncV: 2, coins: 100 }, baseVersion: initial.data.version }, binding)).status, 409);
  assert.equal((await call('GET', undefined, binding)).data.save.coins, 600);
  sqlite.close();
});

const dbSource = readFileSync(new URL('../js/core/db.js', import.meta.url), 'utf8');
const cfDataSource = readFileSync(new URL('../js/net/cf-data.js', import.meta.url), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function browserDevice(server, isNewUser, entries = new Map(), sdkUnavailable = false, firebaseConfig = { apiKey: 'test', projectId: 'test' }, options = {}) {
  let nextLoginIsNew = isNewUser;
  const storage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key)
  };
  const user = {
    uid, displayName: 'Player',
    metadata: { creationTime: options.creationTime || '2026-10-14T15:22:00Z' },
    getIdToken: async () => 'token'
  };
  const auth = {
    currentUser: null,
    setPersistence: async () => {},
    onAuthStateChanged(fn) { queueMicrotask(() => fn(null)); return () => {}; },
    async signInWithPopup() {
      this.currentUser = user;
      const result = { user, additionalUserInfo: { isNewUser: nextLoginIsNew } };
      nextLoginIsNew = false;
      return result;
    },
    async createUserWithEmailAndPassword() {
      this.currentUser = user;
      return { user };
    }
  };
  const authFactory = () => auth;
  authFactory.Auth = { Persistence: { LOCAL: 'local' } };
  authFactory.GoogleAuthProvider = class {};
  let firestoreReads = 0;
  const firestore = () => ({ collection: () => ({ doc: () => ({
    async get() {
      firestoreReads++;
      if (options.firestoreSave) return { exists: true, data: () => ({ save: copy(options.firestoreSave) }) };
      throw new Error('Firestore should not be read');
    }
  }) }) });
  const cloud = {
    enabled: () => true,
    async getSaveState() {
      if (server.rejectReads) { const error = new Error('unavailable'); error.code = 'unavailable'; throw error; }
      return { save: server.save && copy(server.save), version: server.version, protocol: 2 };
    },
    async putSaveState(save, baseVersion) {
      if (server.rejectWrites) { const error = new Error('unavailable'); error.code = 'unavailable'; throw error; }
      if (baseVersion !== server.version) { const error = new Error('save_conflict'); error.code = 'save_conflict'; throw error; }
      server.save = copy(save);
      server.version = hash(server.save);
      return { ok: true, version: server.version };
    },
    async putSave(save) { server.save = copy(save); return { ok: true }; }
  };
  const G = {
    FIREBASE_CONFIG: firebaseConfig, I18n: { lang: 'en' }, CFData: cloud,
    T: value => value, UI: { refreshCoins() {}, toast() {} }
  };
  const context = {
    G, localStorage: storage, location: { protocol: 'https:', hostname: 'pokesurvivor.xyz' }, navigator: { onLine: true },
    document: {
      createElement: () => ({}), head: { appendChild: el => queueMicrotask(() => sdkUnavailable ? el.onerror() : el.onload()) },
      addEventListener() {}
    },
    firebase: { initializeApp() {}, auth: authFactory, firestore },
    addEventListener() {}, setTimeout: (fn, delay) => { const timer = setTimeout(fn, delay); timer.unref(); return timer; },
    clearTimeout, console, TextEncoder, Date
  };
  runInNewContext(dbSource, context);
  return { db: G.DB, entries, get firestoreReads() { return firestoreReads; } };
}

test('a new Google account creates its first CF save without touching Firestore', async () => {
  const server = { save: null, version: null };
  const first = browserDevice(server, true);
  await first.db.ready();
  assert.equal((await first.db.loginWithGoogle()).ok, true);
  assert.equal(first.firestoreReads, 0);
  assert.equal(first.db.syncState, 'ok');
  assert.equal(server.save.syncV, 2);

  first.db.save.coins += 50;
  first.db.save.stats.runs++;
  first.db.commit();
  assert.equal(first.db.syncState, 'pending');
  await first.db.flush();
  assert.equal(first.db.syncState, 'ok');

  const second = browserDevice(server, false);
  await second.db.ready();
  assert.equal((await second.db.loginWithGoogle()).ok, true);
  assert.equal(second.firestoreReads, 0);
  assert.equal(second.db.save.coins, 550);
  assert.equal(second.db.save.stats.runs, 1);

  first.db.save.coins += 30;
  first.db.commit();
  second.db.save.coins += 20;
  second.db.commit();
  await second.db.flush();
  await first.db.flush();
  assert.equal(first.db.syncState, 'conflict');
  assert.equal(first.db.save.coins, 580);
  assert.equal(server.save.coins, 570);
  assert.equal(JSON.parse(first.entries.get('ps.cloud.' + uid)).coins, 580);

  const reopened = browserDevice(server, false, first.entries);
  await reopened.db.ready();
  assert.equal((await reopened.db.loginWithGoogle()).ok, true);
  assert.equal(reopened.db.syncState, 'conflict');
  assert.equal(reopened.db.save.coins, 580);
  assert.equal(reopened.firestoreReads, 0);
});

test('failed first upload keeps local progress and a second device does not invent a blank save', async () => {
  const server = { save: null, version: null, rejectWrites: true };
  const first = browserDevice(server, true);
  await first.db.ready();
  assert.equal((await first.db.loginWithGoogle()).ok, false);
  assert.equal(first.db.syncState, 'offline');
  assert.equal(first.firestoreReads, 0);
  assert.equal(JSON.parse(first.entries.get('ps.cloud.' + uid)).syncV, 2);

  const second = browserDevice(server, false);
  await second.db.ready();
  assert.equal((await second.db.loginWithGoogle()).ok, false);
  assert.equal(second.db.save, null);
  assert.equal(second.firestoreReads, 0);
  assert.equal(server.save, null);
});

test('an older account with no CF save retains its isolated Firestore migration path', async () => {
  const server = { save: null, version: null };
  const legacy = { name: 'Veteran', coins: 321, updated: 100 };
  const device = browserDevice(server, false, new Map(), false,
    { apiKey: 'test', projectId: 'test' },
    { creationTime: '2026-10-13T12:00:00Z', firestoreSave: legacy });
  await device.db.ready();
  assert.equal((await device.db.loginWithGoogle()).ok, true);
  assert.equal(device.firestoreReads, 1);
  assert.equal(device.db.save.coins, 321);
  assert.notEqual(device.db.save.syncV, 2);
});

test('a later login to a new account with no CF save does not consult even an existing Firestore document', async () => {
  const server = { save: null, version: null };
  const device = browserDevice(server, false, new Map(), false,
    { apiKey: 'test', projectId: 'test' },
    { creationTime: '2026-10-14T15:22:00Z', firestoreSave: { name: 'Wrong copy', coins: 999 } });
  await device.db.ready();
  assert.equal((await device.db.loginWithGoogle()).ok, false);
  assert.equal(device.firestoreReads, 0);
  assert.equal(device.db.save, null);
  assert.equal(server.save, null);
});

test('an unknown account creation time fails closed when CF has no save', async () => {
  const server = { save: null, version: null };
  const device = browserDevice(server, false, new Map(), false,
    { apiKey: 'test', projectId: 'test' },
    { creationTime: 'invalid', firestoreSave: { name: 'Unknown', coins: 999 } });
  await device.db.ready();
  assert.equal((await device.db.loginWithGoogle()).ok, false);
  assert.equal(device.firestoreReads, 0);
  assert.equal(server.save, null);
});

test('new signup during a CF outage keeps a recoverable local copy until the service returns', async () => {
  const server = { save: null, version: null, rejectReads: true, rejectWrites: true };
  const first = browserDevice(server, true);
  await first.db.ready();
  assert.equal((await first.db.loginWithGoogle()).ok, false);
  assert.equal(first.db.syncState, 'offline');
  assert.equal(first.firestoreReads, 0);
  assert.equal(JSON.parse(first.entries.get('ps.cloud.' + uid)).syncV, 2);
  server.rejectReads = false;
  server.rejectWrites = false;
  assert.equal((await first.db.loginWithGoogle()).ok, true);
  assert.equal(first.db.syncState, 'ok');
  assert.equal(server.save.syncV, 2);
});

test('a new name-and-password account also skips Firestore on first save', async () => {
  const server = { save: null, version: null };
  const first = browserDevice(server, false);
  await first.db.ready();
  assert.equal((await first.db.register('Tester', 'secret-password')).ok, true);
  assert.equal(first.firestoreReads, 0);
  assert.equal(server.save.name, 'Tester');
  assert.equal(server.save.syncV, 2);
});

test('a Firebase SDK outage does not silently create a browser-only account', async () => {
  const server = { save: null, version: null };
  const device = browserDevice(server, false, new Map(), true);
  assert.equal(await device.db.ready(), false);
  assert.equal((await device.db.register('Tester', 'secret-password')).ok, false);
  assert.equal((await device.db.login('Tester', 'secret-password')).ok, false);
  assert.equal(server.save, null);
});

test('missing Firebase configuration on the published site also blocks local accounts', async () => {
  const device = browserDevice({ save: null, version: null }, false, new Map(), false, null);
  assert.equal(await device.db.ready(), false);
  assert.equal((await device.db.register('Tester', 'secret-password')).ok, false);
  assert.equal((await device.db.login('Tester', 'secret-password')).ok, false);
});

test('a save request refuses a switched Firebase identity before sending data', async () => {
  let sent = false;
  const currentUser = { uid: 'another-user', getIdToken: async () => 'wrong-token' };
  const G = { FIREBASE_DATA_URL: 'https://api.pokesurvivor.xyz', DB: { fb: { auth: { currentUser } } } };
  runInNewContext(cfDataSource, { G, fetch: async () => { sent = true; return Response.json({ ok: true }); }, Error, JSON });
  await assert.rejects(G.CFData.putSaveState({ syncV: 2 }, null, uid), error => error.code === 'identity_changed');
  assert.equal(sent, false);
});

process.on('exit', () => { globalThis.fetch = originalFetch; });
