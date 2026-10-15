/* ============ arena-online.js — online Arena transport ============
 *
 * This is deliberately a transport layer, not a second game loop. The
 * classic controls and combat stay in the existing client while the server
 * owns the paid seat, room assignment, reconnect lease and final ledger.
 */
G.ArenaOnline = (() => {
  let socket = null;
  let matchId = '';
  let wanted = false;
  let heartbeat = 0;
  let retryTimer = 0;
  let retryStarted = 0;
  let openResolve = null;
  let openReject = null;
  let handlers = {};

  const base = () => String(G.FIREBASE_DATA_URL || '').replace(/\/$/, '');
  const enabled = () => !!(G.CFData && G.CFData.enabled && G.CFData.enabled()
    && window.WebSocket && G.DB && G.DB.fb && G.DB.fb.auth && G.DB.fb.auth.currentUser);
  const wsUrl = id => base().replace(/^http/i, 'ws') + '/v1/arena/ws?match=' + encodeURIComponent(id);
  const send = value => { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };

  function stopTimers() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = 0; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = 0; }
  }

  function finishOpen(error) {
    if (error && openReject) openReject(error);
    if (!error && openResolve) openResolve(true);
    openResolve = openReject = null;
  }

  async function connect(match, options = {}) {
    if (!enabled()) throw new Error('arena_online_unavailable');
    close(false);
    matchId = String(match || '');
    if (!/^am_[A-Za-z0-9]{20,64}$/.test(matchId)) throw new Error('invalid_arena_match');
    wanted = true;
    retryStarted = Date.now();
    handlers = options || {};
    const token = await G.DB.fb.auth.currentUser.getIdToken();
    return new Promise((resolve, reject) => {
      openResolve = resolve; openReject = reject;
      const openSocket = () => {
        if (!wanted) return;
        try { socket = new WebSocket(wsUrl(matchId), ['ps-v1']); }
        catch (error) { finishOpen(error); return; }
        socket.onopen = () => send({ type: 'auth', token });
        socket.onmessage = event => {
          let value;
          try { value = JSON.parse(event.data); } catch (e) { return; }
          if (!value) return;
          if (value.type === 'auth') {
            if (!value.ok) { if (openReject) finishOpen(new Error(value.error || 'unauthorized')); return; }
            send({ type: 'join' });
            if (!heartbeat) heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15000);
            return;
          }
          if (value.type === 'arena') {
            if (openResolve) finishOpen();
            if (typeof handlers.onMatch === 'function') handlers.onMatch(value.match);
          } else if (value.type === 'state' && typeof handlers.onState === 'function') handlers.onState(value.state);
          else if (value.type === 'action' && typeof handlers.onAction === 'function') handlers.onAction(value.uid, value.action);
          else if (value.type === 'report' && typeof handlers.onReport === 'function') handlers.onReport(value.result);
          else if (value.type === 'error' && typeof handlers.onError === 'function') handlers.onError(value.error);
        };
        socket.onerror = () => {
          if (openReject) finishOpen(new Error('arena_connection'));
        };
        socket.onclose = () => {
          socket = null;
          if (!wanted) return;
          if (Date.now() - retryStarted > 45000) {
            if (typeof handlers.onClose === 'function') handlers.onClose('reconnect_expired');
            return;
          }
          const delay = Math.min(5000, 500 + Math.floor(Math.random() * 700));
          retryTimer = setTimeout(() => { retryTimer = 0; openSocket(); }, delay);
          if (typeof handlers.onClose === 'function') handlers.onClose('reconnecting');
        };
      };
      openSocket();
    });
  }

  function close(explicit = true) {
    wanted = false;
    stopTimers();
    const old = socket;
    socket = null;
    if (old) {
      if (explicit && old.readyState === WebSocket.OPEN) { try { old.send(JSON.stringify({ type: 'leave' })); } catch (e) { /* nada */ } }
      try { old.close(); } catch (e) { /* nada */ }
    }
    finishOpen(new Error('arena_closed'));
    if (explicit && typeof handlers.onClose === 'function') handlers.onClose('closed');
  }

  return {
    enabled,
    queue: value => G.CFData.arenaQueue(value),
    status: () => G.CFData.arenaQueueStatus(),
    cancelQueue: () => G.CFData.arenaCancelQueue(),
    report: value => G.CFData.arenaReport(Object.assign({}, value, { matchId })),
    connect,
    close,
    sendState(value) { send({ type: 'state', state: value || {} }); },
    sendAction(value) { send({ type: 'action', action: value || {} }); },
    get matchId() { return matchId; },
    get active() { return wanted && !!socket && socket.readyState === WebSocket.OPEN; }
  };
})();
