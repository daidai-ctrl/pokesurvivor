/* ============ cf-data.js — Cloudflare D1 data client ============
 *
 * The Firebase ID token is only used as identity proof. The Worker verifies
 * it and stores application data in D1. Every method fails normally so the
 * caller can keep its legacy Firebase fallback during the migration.
 */
G.CFData = (() => {
  const base = () => String(G.FIREBASE_DATA_URL || '').replace(/\/$/, '');
  // During openCloud() the uid/save have not been assigned yet, so DB.online
  // is still false. The Firebase auth object is the correct readiness check.
  const enabled = () => !!(base() && G.DB && G.DB.fb && G.DB.fb.auth && G.DB.fb.auth.currentUser);

  async function request(path, options = {}) {
    if (!enabled()) { const e = new Error('Cloudflare data API is not ready'); e.code = 'cf-not-ready'; throw e; }
    const currentUser = G.DB.fb.auth.currentUser;
    if (options.expectedUid && currentUser.uid !== options.expectedUid) {
      const e = new Error('Firebase identity changed before the save request');
      e.code = 'identity_changed'; throw e;
    }
    const token = await currentUser.getIdToken();
    const headers = Object.assign({ Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, options.headers || {});
    const { expectedUid, ...fetchOptions } = options;
    const r = await fetch(base() + path, Object.assign({}, fetchOptions, { headers }));
    let data = null;
    try { data = await r.json(); } catch (e) { /* empty response */ }
    if (!r.ok) { const e = new Error((data && data.error) || ('Cloudflare data API ' + r.status)); e.code = (data && data.error) || ('http-' + r.status); e.status = r.status; throw e; }
    return data || {};
  }

  const qs = obj => Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const get = path => request(path);
  const put = (path, value) => request(path, { method: 'PUT', body: JSON.stringify(value || {}) });
  const del = path => request(path, { method: 'DELETE' });

  return {
    enabled,
    request,
    getSave: async () => (await get('/v1/save')).save || null,
    getSaveState: expectedUid => request('/v1/save', { expectedUid }),
    putSave: (value, expectedUid) => request('/v1/save', { method: 'PUT', body: JSON.stringify({ save: value }), expectedUid }),
    putSaveState: (value, baseVersion, expectedUid) => request('/v1/save', { method: 'PUT', body: JSON.stringify({ save: value, baseVersion }), expectedUid }),
    deleteSave: () => del('/v1/save'),
    putRun: value => put('/v1/run', value),
    deleteRun: () => del('/v1/run'),
    putCollection: value => put('/v1/collection', value),
    deleteCollection: () => del('/v1/collection'),
    collectionTop: uids => get('/v1/collection' + (uids && uids.length ? '?' + qs({ uids: uids.join(',') }) : ''))
      .then(x => x.rows || []),
    summary: board => get('/v1/ranking/summary?' + qs({ board })).then(x => x.hasData ? (x.top || {}) : null),
    entry: (board, id) => get('/v1/ranking/entry?' + qs({ board, id })).then(x => x.entry || null),
    users: (board, uids) => request('/v1/ranking/users', { method: 'POST', body: JSON.stringify({ board, uids }) }).then(x => x.entries || []),
    countAbove: (board, t) => get('/v1/ranking/count?' + qs({ board, t })).then(x => +x.count || 0),
    storeRanking: (boards, id, entry) => request('/v1/ranking/store', { method: 'POST', body: JSON.stringify({ boards, id, entry }) }),
    removeRanking: () => del('/v1/ranking/remove'),
    shareRewardStatus: campaign => get('/v1/rewards/share?' + qs({ campaign })),
    claimShareReward: campaign => request('/v1/rewards/share', { method: 'POST', body: JSON.stringify({ campaign }) }),
    getProfile: uid => get('/v1/profile?' + qs({ uid })).then(x => x.profile || null),
    putProfile: value => put('/v1/profile', value),
    deleteProfile: () => del('/v1/profile'),
    lookupName: lower => get('/v1/name?' + qs({ lower })).then(x => x.name || null),
    claimName: lower => put('/v1/name?' + qs({ lower }), {}),
    deleteName: lower => del('/v1/name?' + qs({ lower })),
    friendships: () => get('/v1/friendships').then(x => x.friendships || []),
    putFriendship: value => put('/v1/friendships', value),
    patchFriendship: value => request('/v1/friendships', { method: 'PATCH', body: JSON.stringify(value || {}) }),
    deleteFriendship: id => del('/v1/friendships?' + qs({ id })),
    invites: () => get('/v1/invites').then(x => x.invites || []),
    putInvite: value => put('/v1/invites', value),
    deleteInvite: id => del('/v1/invites?' + qs({ id })),
    putPresence: value => put('/v1/presence', value),
    presence: uids => get('/v1/presence?' + qs({ uids: uids.join(',') })).then(x => x.presence || []),
    deletePresence: () => del('/v1/presence'),
    deleteAccount: () => del('/v1/account')
  };
})();
