/* ============ arena-mvp.js — entrada local/online al modo arena ============
 *
 * Este MVP no inventa un segundo motor de combate. La pantalla sólo prepara
 * la selección del personaje y después entra en G.Game.startRun(), por lo que
 * el jugador usa el mapa, movimiento WASD/táctil, habilidades, experiencia y
 * mejoras del modo clásico.
 *
 * Esta copia local usa monedas blandas para probar la economía del modo:
 * 100 monedas de entrada y 700 monedas para el ganador. Los tickets quedan
 * reservados para una fase posterior, después de validar el equilibrio.
 */
G.ArenaMVP = (() => {
  const $ = G.UI.$;
  const MAX_PLAYERS = 8;
  const ENTRY_COINS = 100;
  const WINNER_PAYOUT = 700;
  const TEST_BOTS = true;
  const BOT_NAMES = ['Rival-01', 'Rival-02', 'Rival-03', 'Rival-04', 'Rival-05', 'Rival-06', 'Rival-07'];

  const state = {
    owned: [],
    selected: null,
    room: [],
    onlineMatch: '',
    onlineSnapshot: null,
    onlineQueueing: false,
    onlinePollTimer: 0,
    onlinePollBusy: false
  };

  const onlineEnabled = () => !!(G.ArenaOnline && G.ArenaOnline.enabled && G.ArenaOnline.enabled());
  const onlineRequestId = () => `arena-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  function stopOnlinePolling() {
    if (state.onlinePollTimer) { clearTimeout(state.onlinePollTimer); state.onlinePollTimer = 0; }
    state.onlinePollBusy = false;
  }

  function clearOnlineState(cancel = false) {
    stopOnlinePolling();
    if (cancel && state.onlineQueueing && onlineEnabled()) {
      G.ArenaOnline.cancelQueue()
        .then(() => G.DB && G.DB.applyServerSave ? G.DB.applyServerSave({}) : null)
        .catch(() => {});
    }
    state.onlineQueueing = false;
    state.onlineMatch = '';
    state.onlineSnapshot = null;
  }

  function esc(s) {
    return String(s).replace(/[&<>'\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '\"': '&quot;' }[ch]));
  }

  function legendsOwned() {
    const save = G.DB.save || {};
    const owned = save.owned || {};
    // La primera versión sólo admite legendarios que el jugador ya posee.
    return G.DEX.filter(p => p.rarity === 5 && owned[p.dex]).sort((a, b) => a.dex - b.dex);
  }

  function open() {
    clearOnlineState(false);
    G.UI.chrome(true);
    G.UI.show('scr-arena');
    state.owned = legendsOwned();
    state.selected = state.owned.some(p => p.dex === state.selected)
      ? state.selected
      : (state.owned[0] && state.owned[0].dex) || null;
    state.room = [];
    $('arena-battle').classList.add('hidden');
    $('arena-setup').classList.remove('hidden');
    renderRoles();
    renderRoleDetail();
    renderRoom();
  }

  function renderRoles() {
    const select = $('arena-role');
    select.innerHTML = '';
    if (!state.owned.length) {
      const opt = document.createElement('option');
      opt.textContent = 'Aún no tienes un legendario';
      opt.value = '';
      select.appendChild(opt);
      select.disabled = true;
      $('arena-join').disabled = true;
      $('arena-note').textContent = 'Necesitas tener al menos un personaje legendario propio y 100 monedas para probar este modo.';
      return;
    }
    select.disabled = false;
    for (const p of state.owned) {
      const opt = document.createElement('option');
      opt.value = String(p.dex);
      opt.textContent = `${p.name} · ${G.Gacha.RARITY_NAME[p.rarity] || 'Legendario'}`;
      opt.selected = p.dex === state.selected;
      select.appendChild(opt);
    }
    const enoughCoins = Number(G.DB.save?.coins || 0) >= ENTRY_COINS;
    $('arena-join').disabled = !enoughCoins;
    const onlineButton = $('arena-online-queue');
    if (onlineButton) onlineButton.disabled = !enoughCoins || !onlineEnabled();
    if (!enoughCoins) {
      $('arena-note').textContent = `Necesitas ${ENTRY_COINS} monedas para entrar. Los tickets amarillos todavía no se utilizan.`;
    } else if (onlineButton && !onlineEnabled()) {
      $('arena-note').textContent = 'El emparejamiento online todavía no está disponible en este entorno; puedes usar la sala local de prueba.';
    }
    select.onchange = () => {
      state.selected = Number(select.value) || null;
      renderRoleDetail();
    };
  }

  function renderRoleDetail() {
    const mon = state.owned.find(p => p.dex === state.selected);
    const cv = $('arena-role-stage');
    const detail = $('arena-role-detail');
    if (!mon) {
      detail.innerHTML = '<p class="note">Selecciona un personaje propio para continuar.</p>';
      return;
    }
    cv.style.setProperty('--stage-c', G.U.TYPE_COLOR[mon.types[0]] || '#5b83d6');
    G.UI.sprite(cv, mon.dex, { lively: true, scale: 3, hero: true });
    const pool = G.Moves.poolFor(mon);
    const names = pool.map(id => G.Moves.BY_ID[id]).filter(Boolean).slice(0, 8);
    detail.innerHTML = `
      <div class="arena-role-title"><b>${esc(mon.name)}</b> ${G.UI.stars(mon.rarity, 12)}</div>
      <div class="arena-role-stats">HP ${mon.hp} · ATK ×${mon.atk.toFixed(2)} · SPD ${mon.spd}</div>
      <div class="arena-role-moves"><span class="sub">Habilidades compatibles:</span> ${names.map(m => `<span class="chip">${esc(m.name)}</span>`).join('')}</div>`;
  }

  function joinRoom() {
    const dex = Number($('arena-role').value);
    const mon = state.owned.find(p => p.dex === dex);
    if (!mon) return;
    state.selected = dex;
    state.room = [{ id: 'local', name: G.DB.save.name || 'Tú', dex, human: true }];
    if (TEST_BOTS) {
      // Bots can repeat a character: the MVP has no per-dex limit. They use
      // legendary kits too, but the human still must own the selected role.
      const legends = G.DEX.filter(p => p.rarity === 5);
      for (let i = 0; i < MAX_PLAYERS - 1; i++) {
        const botMon = legends[(i * 3 + 1) % Math.max(1, legends.length)];
        state.room.push({ id: `bot-${i + 1}`, name: BOT_NAMES[i], dex: botMon ? botMon.dex : dex, human: false });
      }
    }
    renderRoom();
    $('arena-note').textContent = TEST_BOTS
      ? `Sala de prueba completa: 1 jugador + ${MAX_PLAYERS - 1} personas de prueba. Se usan el mapa, WASD y las habilidades normales; no se descuenta nada.`
      : `Has ocupado 1/${MAX_PLAYERS} plaza con ${mon.name}. La selección repetida no tiene límite por personaje.`;
  }

  function snapshotRoom(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.players)) return;
    const uid = String(G.DB.fb?.uid || G.DB.fb?.auth?.currentUser?.uid || '');
    state.onlineSnapshot = snapshot;
    state.onlineMatch = String(snapshot.match?.matchId || '');
    state.room = snapshot.players.map(member => ({
      id: member.uid,
      uid: member.uid,
      name: member.name || 'Jugador',
      dex: Number(member.dex),
      shiny: !!member.shiny,
      seat: Number(member.seat),
      human: String(member.uid) === uid,
      online: true,
      status: member.status
    }));
  }

  function renderOnlineQueue(result) {
    if (!result) return;
    if (result.match) {
      stopOnlinePolling();
      state.onlineQueueing = false;
      snapshotRoom(result);
      renderRoom();
      $('arena-note').textContent = `Servidor asignó la sala ${state.onlineMatch.slice(-8)}. Cuando estés listo, entra al combate; la entrada ya quedó reservada en el servidor.`;
      return;
    }
    if (result.status === 'queued') {
      state.onlineQueueing = true;
      const position = Math.max(1, Number(result.position) || 1);
      $('arena-count').textContent = `cola #${position}`;
      $('arena-start').disabled = true;
      $('arena-note').textContent = `Buscando 8 jugadores reales… posición aproximada ${position}. Puedes reiniciar para cancelar y recibir el reembolso del servidor.`;
    }
  }

  function pollOnlineQueue() {
    if (!state.onlineQueueing || state.onlinePollTimer) return;
    state.onlinePollTimer = setTimeout(async () => {
      state.onlinePollTimer = 0;
      if (!state.onlineQueueing || state.onlinePollBusy) return pollOnlineQueue();
      state.onlinePollBusy = true;
      try { renderOnlineQueue(await G.ArenaOnline.status()); }
      catch (error) {
        $('arena-note').textContent = `No se pudo consultar la cola: ${error.message || 'error de red'}.`;
      } finally {
        state.onlinePollBusy = false;
        pollOnlineQueue();
      }
    }, 1500);
  }

  async function queueOnline() {
    const dex = Number($('arena-role').value);
    const mon = state.owned.find(p => p.dex === dex);
    if (!mon || !onlineEnabled()) return;
    state.selected = dex;
    state.onlineQueueing = true;
    state.onlineMatch = '';
    state.onlineSnapshot = null;
    $('arena-online-queue').disabled = true;
    $('arena-join').disabled = true;
    try {
      const result = await G.ArenaOnline.queue({
        requestId: onlineRequestId(),
        dex,
        shiny: false,
        name: G.DB.save?.name || 'Jugador'
      });
      // The server has already debited the entry fee. Refresh the local copy
      // before any other save operation can accidentally push the old wallet
      // back to the cloud.
      if (G.DB && G.DB.applyServerSave) await G.DB.applyServerSave(result);
      renderOnlineQueue(result);
      pollOnlineQueue();
    } catch (error) {
      state.onlineQueueing = false;
      $('arena-note').textContent = `No se pudo entrar a la cola: ${error.message || 'error de red'}. No se ha cobrado nada localmente.`;
      renderRoles();
    }
  }

  function renderRoom() {
    const list = $('arena-slots');
    list.innerHTML = '';
    $('arena-count').textContent = `${state.room.length}/${MAX_PLAYERS}`;
    if (!state.room.length) {
      list.innerHTML = '<p class="note arena-empty">La sala está vacía. Selecciona un personaje y entra.</p>';
    } else {
      for (const [i, member] of state.room.entries()) {
        const mon = G.DEX_BY[member.dex];
        const el = document.createElement('div');
        el.className = 'arena-slot' + (member.human ? ' human' : '');
        const suffix = member.human ? ' · tú' : member.online ? ' · jugador' : ' · IA de prueba';
        el.innerHTML = `<span class="arena-slot-no">${i + 1}</span><span class="arena-slot-name">${esc(member.name)}${suffix}</span><span class="arena-slot-mon">${esc(mon ? mon.name : '???')}</span>`;
        list.appendChild(el);
      }
    }
    $('arena-start').disabled = state.room.length === 0 || state.onlineQueueing;
  }

  async function startOnlineMatch() {
    const snapshot = state.onlineSnapshot;
    const me = snapshot && snapshot.player;
    if (!snapshot || !state.onlineMatch || !me) {
      $('arena-note').textContent = 'La sala online todavía no está lista; espera a que el servidor la asigne.';
      return;
    }
    $('arena-start').disabled = true;
    $('arena-note').textContent = 'Conectando con la sala…';
    try {
      await G.ArenaOnline.connect(state.onlineMatch, {
        onMatch: next => { snapshotRoom(next); },
        onState: remoteState => { if (G.Arena && G.Arena.active) G.Arena.applyRemoteState(remoteState); },
        onAction: (uid, action) => { if (G.Arena && G.Arena.active) G.Arena.applyRemoteAction(uid, action); },
        onReport: result => {
          if (result && result.match && G.DB && G.DB.applyServerSave) G.DB.applyServerSave(result.save || {}).catch(() => {});
        },
        onError: error => console.warn('[Arena] online room', error)
      });
      G.Game.startRun({
        mode: 'arena',
        partnerDex: Number(me.dex),
        maxPlayers: MAX_PLAYERS,
        entryCoins: ENTRY_COINS,
        winnerPayout: WINNER_PAYOUT,
        arenaEntryPaid: true,
        onlineArena: true,
        matchId: state.onlineMatch,
        seed: Number(snapshot.match?.seed) || 0,
        initialElapsed: Math.max(0, (Date.now() - Number(snapshot.match?.startedAt || Date.now())) / 1000),
        playerSeat: Number(me.seat),
        remotePlayers: snapshot.players.filter(member => String(member.uid) !== String(me.uid)),
        testBots: false,
        botCount: 0
      });
    } catch (error) {
      G.ArenaOnline.close();
      $('arena-start').disabled = false;
      $('arena-note').textContent = `连接房间失败：${error.message || '网络错误'}。没有启动战斗。`;
    }
  }

  function startClassicPreview() {
    if (!state.room.length) return;
    if (state.onlineMatch) { startOnlineMatch(); return; }
    const save = G.DB.save || {};
    if (Number(save.coins || 0) < ENTRY_COINS) {
      $('arena-note').textContent = `Monedas insuficientes: necesitas ${ENTRY_COINS}.`;
      return;
    }
    // Charge exactly once when the local match is actually started, not when
    // the player only selects a role or previews the room.
    save.coins = Math.max(0, Number(save.coins || 0) - ENTRY_COINS);
    G.DB.commit();
    const member = state.room[0];
    // No cambia save.partner: sólo pasa la selección al arranque de esta run.
    // Game.startRun conserva el mismo mapa, controles, habilidades y loop.
    G.Game.startRun({
      mode: 'arena',
      partnerDex: member.dex,
      maxPlayers: MAX_PLAYERS,
      entryCoins: ENTRY_COINS,
      winnerPayout: WINNER_PAYOUT,
      arenaEntryPaid: true,
      localPreview: true,
      testBots: TEST_BOTS,
      botCount: Math.max(0, state.room.length - 1)
    });
  }

  function reset() {
    clearOnlineState(true);
    state.room = [];
    $('arena-battle').classList.add('hidden');
    $('arena-setup').classList.remove('hidden');
    renderRoles();
    renderRoom();
    $('arena-note').textContent = '房间已清空；测试版不会使用黄色兑换券。';
  }

  function backToMenu() {
    clearOnlineState(true);
    if (G.Game && G.Game.mode === 'arena') {
      if (G.Game.leaveArenaToMenu) G.Game.leaveArenaToMenu();
      else G.Game.leaveArena();
      return;
    }
    G.MenuUI.open();
  }

  function init() {
    $('arena-join').onclick = joinRoom;
    $('arena-online-queue').onclick = queueOnline;
    $('arena-start').onclick = startClassicPreview;
    $('arena-reset').onclick = reset;
    $('arena-exit').onclick = backToMenu;
    $('arena-menu').onclick = backToMenu;
    $('arena-menu-battle').onclick = backToMenu;
    $('arena-death-exit').onclick = () => G.Game.leaveArena();
  }

  init();
  return { open };
})();
