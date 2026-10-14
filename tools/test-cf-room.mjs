import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('Cloudflare room opens and registers its state callback before connecting', async () => {
  let socketUrl = '';
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url, protocols) {
      socketUrl = url;
      assert.deepEqual(Array.from(protocols), ['ps-v1']);
      this.readyState = FakeWebSocket.OPEN;
      queueMicrotask(() => this.onopen());
    }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.type === 'auth') {
        assert.equal(message.token, 'test-token');
        queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: 'auth', ok: true }) }));
      } else if (message.type === 'join') {
        assert.equal(message.create, true);
        queueMicrotask(() => this.onmessage({ data: JSON.stringify({
          type: 'room', room: { id: 'testroom123', host: 'test-user', open: true, members: [{ uid: 'test-user' }] }
        }) }));
      }
    }
    close() { this.readyState = 3; }
  }

  const G = {
    FIREBASE_DATA_URL: 'https://api.pokesurvivor.xyz',
    DB: { fb: { auth: { currentUser: { getIdToken: async () => 'test-token' } } } }
  };
  const context = { G, window: { WebSocket: FakeWebSocket }, WebSocket: FakeWebSocket,
    setTimeout, clearTimeout, setInterval, clearInterval, console };
  vm.runInNewContext(await readFile(new URL('../js/net/cf-room.js', import.meta.url), 'utf8'), context);
  const states = [];
  const room = await G.CFRoom.open('testroom123', { create: true, member: { name: 'Test' }, onState: state => states.push(state) });
  assert.equal(room.id, 'testroom123');
  assert.equal(states.length, 1);
  assert.equal(G.CFRoom.active, true);
  assert.match(socketUrl, /^wss:\/\/api\.pokesurvivor\.xyz\/v1\/room\/ws\?room=testroom123$/);
  G.CFRoom.close(false);
  assert.equal(G.CFRoom.active, false);
});
