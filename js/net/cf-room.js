/* ============ cf-room.js — Cloudflare room WebSocket ============
 *
 * Firebase Authentication remains the identity source. This channel only
 * carries ephemeral room membership, signaling and relay messages, so moving
 * it off RTDB does not touch saves, accounts, rankings or social records.
 */
G.CFRoom = (() => {
  let socket = null, roomId = null, heartbeat = 0, openTimer = 0, sessionStateOff = null;
  const stateListeners = new Set(), messageListeners = new Set();
  let active = false;

  const base = () => String(G.FIREBASE_DATA_URL || '').replace(/\/$/, '');
  const wsUrl = id => base().replace(/^http/i, 'ws') + '/v1/room/ws?room=' + encodeURIComponent(id);
  const enabled = () => !!(base() && window.WebSocket && G.DB && G.DB.fb && G.DB.fb.auth && G.DB.fb.auth.currentUser);
  const send = value => { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    const bytes = new Uint8Array(18);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  function stopHeartbeat() { if (heartbeat) { clearInterval(heartbeat); heartbeat = 0; } }

  function close(sendLeave = true) {
    stopHeartbeat();
    if (openTimer) { clearTimeout(openTimer); openTimer = 0; }
    if (sessionStateOff) { sessionStateOff(); sessionStateOff = null; }
    const s = socket;
    socket = null; active = false; roomId = null;
    if (s) {
      if (sendLeave && s.readyState === WebSocket.OPEN) {
        try { s.send(JSON.stringify({ type: 'leave' })); } catch (e) { /* already closing */ }
      }
      try { s.close(); } catch (e) { /* already closed */ }
    }
  }

  async function open(id, options = {}) {
    if (!enabled()) throw new Error('room_unavailable');
    close(false);
    roomId = String(id || '');
    if (typeof options.onState === 'function') sessionStateOff = onState(options.onState);
    const token = await G.DB.fb.auth.currentUser.getIdToken();
    return new Promise((resolve, reject) => {
      let settled = false, failed = false;
      const fail = error => {
        if (failed) return;
        failed = true; stopHeartbeat(); active = false;
        if (openTimer) { clearTimeout(openTimer); openTimer = 0; }
        if (socket) { try { socket.close(); } catch (e) { /* nada */ } }
        socket = null; roomId = null;
        reject(error instanceof Error ? error : new Error(String(error || 'room_error')));
      };
      try {
        // Authenticate inside the encrypted WebSocket instead of putting the
        // Firebase token in the URL or negotiated subprotocol.
        socket = new WebSocket(wsUrl(roomId), ['ps-v1']);
      } catch (e) { fail(e); return; }
      socket.onopen = () => {
        send({ type: 'auth', token });
      };
      socket.onmessage = event => {
        let message;
        try { message = JSON.parse(event.data); } catch (e) { return; }
        if (!message) return;
        if (message.type === 'auth') {
          if (!message.ok) { if (!settled) fail(new Error(message.error || 'unauthorized')); }
          else {
            send({ type: 'join', create: !!options.create, member: options.member || {} });
            heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15000);
          }
          return;
        }
        if (message.type === 'room' && message.room) {
          active = true;
          if (openTimer) { clearTimeout(openTimer); openTimer = 0; }
          if (!settled) { settled = true; resolve(message.room); }
          stateListeners.forEach(fn => { try { fn(message.room); } catch (e) { console.warn(e); } });
          return;
        }
        if (message.type === 'relay' && message.env) {
          messageListeners.forEach(fn => { try { fn(message.from, message.env); } catch (e) { console.warn(e); } });
          return;
        }
        if (message.type === 'error') {
          const error = new Error(message.error || 'room_error');
          if (!settled) fail(error); else console.warn('[CFRoom]', message.error);
          return;
        }
        if (message.type === 'closed') {
          stateListeners.forEach(fn => { try { fn(null); } catch (e) { console.warn(e); } });
          close(false);
        }
      };
      socket.onerror = () => { if (!settled) fail(new Error('room_connection')); };
      openTimer = setTimeout(() => { if (!settled) fail(new Error('room_timeout')); }, 10000);
      socket.onclose = () => {
        stopHeartbeat();
        const wasActive = active;
        active = false; socket = null;
        if (!settled) fail(new Error('room_connection'));
        else if (wasActive) stateListeners.forEach(fn => { try { fn(null); } catch (e) { console.warn(e); } });
      };
    });
  }

  return {
    enabled,
    newId,
    open,
    close,
    onState(fn) { stateListeners.add(fn); return () => stateListeners.delete(fn); },
    onMessage(fn) { messageListeners.add(fn); return () => messageListeners.delete(fn); },
    send(to, env) { send({ type: 'relay', to: String(to || ''), env }); },
    setOpen(open) { send({ type: 'set-open', open: !!open }); },
    updateMember(member) { send({ type: 'member', member: member || {} }); },
    get active() { return active && !!socket && socket.readyState === WebSocket.OPEN; },
    get id() { return roomId; }
  };
})();
