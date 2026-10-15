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
  // Test bots stay available only on local previews. They must never appear
  // in the public matchmaking flow.
  const TEST_BOTS = ['localhost', '127.0.0.1'].includes(location.hostname) || location.protocol === 'file:';
  const BOT_NAMES = ['Rival-01', 'Rival-02', 'Rival-03', 'Rival-04', 'Rival-05', 'Rival-06', 'Rival-07'];

  const COPY = {
    es: {
      title: 'Último Superviviente', subtitle: '· Battle Royale · Último Superviviente',
      description: 'Modo de supervivencia para 8 jugadores. Usa el mapa, WASD/joystick y las habilidades del modo clásico; durante la prueba se usan monedas y no se descuentan tickets amarillos.',
      slots: '8 plazas', entry: '100 monedas para entrar', prize: 'premio previsto: 700', map: 'Mapa: diámetro circular de 96 casillas', gas: '10:00 + 60 s de gas furioso',
      balance: 'Equilibrio de personajes v3 · 103 personajes · aparición clásica de monstruos · HP 72 % · daño 65 %', monsters: 'Sólo monstruos normales · sin grietas / jefes / eventos aleatorios', queueLabel: 'cola #{x}',
      roleTitle: 'Elige un legendario que ya tengas', roleNote: 'Sólo aparecen personajes propios de rareza legendaria. No hay límite de jugadores por personaje; el límite futuro será sólo de plazas de la sala.',
      joinTest: 'Entrar en sala de prueba', online: 'Emparejar oponentes', roomTest: 'Sala de prueba', roomMatch: 'Emparejamiento', start: 'Entrar al combate', reset: 'Reiniciar', exit: 'Salir al menú',
      emptyTest: 'Selecciona un personaje y entra en la sala de prueba.', emptyMatch: 'Selecciona un personaje y pulsa Emparejar oponentes.', noLegend: 'Aún no tienes un legendario', needLegend: 'Necesitas tener al menos un personaje legendario propio y 100 monedas para probar este modo.',
      needCoins: 'Necesitas {x} monedas para entrar. Los tickets amarillos todavía no se utilizan.', offline: 'El emparejamiento online todavía no está disponible en este entorno; puedes usar la sala local de prueba.',
      testFull: 'Sala de prueba completa: 1 jugador + {x} personas de prueba. Se usan el mapa, WASD y las habilidades normales; pulsa Entrar al combate para comenzar.',
      occupied: 'Has ocupado 1/{x} plaza con {y}. La selección repetida no tiene límite por personaje.',
      queue: 'Buscando 8 oponentes reales… posición aproximada {x}. Puedes reiniciar para cancelar y recibir el reembolso del servidor.',
      assigned: 'Sala completa. Conectando al combate…', connecting: 'Conectando con la sala…', notReady: 'La sala online todavía no está lista; espera a que el servidor la asigne.',
      connectionError: 'Conexión fallida: {x}. No se ha iniciado el combate.', serverError: 'No se pudo entrar a la cola: error de servidor. No se ha cobrado nada.',
      insufficient: 'Monedas insuficientes: necesitas {x}.', resetNote: 'La sala se ha vaciado; la prueba no utiliza tickets amarillos.', self: 'tú', player: 'jugador', bot: 'IA de prueba',
      battleTitle: 'Combate local', battleNote: 'Vista previa ×24 · sala local · entrada 100 monedas · sin tickets amarillos', abandon: 'Abandonar y salir',
      emptyRole: 'Selecciona un personaje propio para continuar.', skills: 'Habilidades compatibles:'
    },
    en: {
      title: 'Last Survivor', subtitle: '· Battle Royale · Last Survivor',
      description: 'An 8-player survival mode. Use the map, WASD/joystick and classic mode abilities; coins are used during the test and yellow tickets are not deducted.',
      slots: '8 slots', entry: '100 coins to enter', prize: 'planned prize: 700', map: 'Map: 96-tile circular diameter', gas: '10:00 + 60 s of frenzy gas',
      balance: 'Character balance v3 · 103 characters · classic monster spawn rate · HP 72% · damage 65%', monsters: 'Ordinary monsters only · no rifts / bosses / random events', queueLabel: 'queue #{x}',
      roleTitle: 'Choose a legendary you already own', roleNote: 'Only legendary characters you own are shown. There is no per-character player limit; the only limit is the room size.',
      joinTest: 'Enter test room', online: 'Find opponents', roomTest: 'Test room', roomMatch: 'Matchmaking', start: 'Enter battle', reset: 'Reset', exit: 'Back to menu',
      emptyTest: 'Select a character and enter the test room.', emptyMatch: 'Select a character and press Find opponents.', noLegend: 'You do not own a legendary yet', needLegend: 'You need to own at least one legendary character and 100 coins to try this mode.',
      needCoins: 'You need {x} coins to enter. Yellow tickets are not used yet.', offline: 'Online matchmaking is not available in this environment; you can use the local test room.',
      testFull: 'Test room full: 1 player + {x} test players. The normal map, WASD and abilities are used; press Enter battle to begin.',
      occupied: 'You took 1/{x} slot with {y}. Duplicate characters are allowed.',
      queue: 'Finding 8 real opponents… approximate position {x}. Reset to cancel and receive the server refund.',
      assigned: 'Match found. Connecting to battle…', connecting: 'Connecting to the room…', notReady: 'The online room is not ready yet; wait for the server to assign it.',
      connectionError: 'Connection failed: {x}. The battle did not start.', serverError: 'Could not enter matchmaking: server error. Nothing was charged.',
      insufficient: 'Not enough coins: you need {x}.', resetNote: 'The room was cleared; the test does not use yellow tickets.', self: 'you', player: 'player', bot: 'test AI',
      battleTitle: 'Local battle', battleNote: 'Preview ×24 · local room · 100-coin entry · no yellow tickets', abandon: 'Leave and exit',
      emptyRole: 'Choose an owned character to continue.', skills: 'Compatible abilities:'
    },
    'zh-hant': {
      title: '皇家生存戰', subtitle: '· 大逃殺 · 皇家生存戰',
      description: '最多 8 人的生存模式。使用地圖、WASD／搖桿與經典模式技能；測試期間使用金幣，不會扣除黃色抽獎券。',
      slots: '8 個名額', entry: '入場費 100 金幣', prize: '預計獎勵：700', map: '地圖：圓形直徑 96 格', gas: '10:00 + 60 秒狂暴毒氣',
      balance: '角色平衡 v3 · 103 個角色 · 經典怪物刷新量 · HP 72% · 傷害 65%', monsters: '僅普通怪物 · 無裂隙／首領／隨機事件', queueLabel: '排隊 #{x}',
      roleTitle: '選擇你已擁有的傳說角色', roleNote: '只會顯示你已擁有的傳說角色。同一角色沒有玩家人數限制，唯一限制是房間名額。',
      joinTest: '進入測試房', online: '匹配對手', roomTest: '測試房間', roomMatch: '正在匹配', start: '進入戰鬥', reset: '重置', exit: '返回主選單',
      emptyTest: '選擇角色後進入測試房。', emptyMatch: '選擇角色後點擊「匹配對手」。', noLegend: '你目前沒有傳說角色', needLegend: '你至少需要擁有一個傳說角色和 100 金幣才能測試這個模式。',
      needCoins: '進入需要 {x} 金幣。測試期間不會使用黃色抽獎券。', offline: '目前環境尚未開放線上匹配，你可以使用本地測試房。',
      testFull: '測試房已滿：1 名玩家 + {x} 名測試玩家。使用正常地圖、WASD 和技能；點擊「進入戰鬥」開始。',
      occupied: '你已使用 {x} 個名額中的 1 個，角色為 {y}。同一角色可以重複選擇。',
      queue: '正在尋找 8 名真人對手……目前約在第 {x} 位。點擊重置可取消並由伺服器退款。',
      assigned: '匹配成功，正在連接戰鬥……', connecting: '正在連接房間……', notReady: '線上房間尚未準備好，請等待伺服器分配。',
      connectionError: '連線失敗：{x}。尚未開始戰鬥。', serverError: '無法進入匹配：伺服器錯誤，尚未扣款。',
      insufficient: '金幣不足：需要 {x}。', resetNote: '房間已清空；測試期間不會使用黃色抽獎券。', self: '你', player: '玩家', bot: '測試 AI',
      battleTitle: '本地戰鬥', battleNote: '預覽速度 ×24 · 本地房間 · 入場費 100 金幣 · 不使用黃色抽獎券', abandon: '離開並退出',
      emptyRole: '請選擇一個自己擁有的角色。', skills: '可用技能：'
    }
  };

  function copy() { return COPY[G.I18n && G.I18n.lang] || COPY.es; }
  function text(id, value) { const el = $(id); if (el) el.textContent = value; }
  function fill(template, ...values) { let i = 0; return template.replace(/\{x\}|\{y\}/g, () => String(values[i++] ?? '')); }

  function applyArenaCopy() {
    const c = copy();
    text('arena-title', c.title); text('arena-title-subtitle', c.subtitle); text('arena-description', c.description);
    text('arena-rule-slots', c.slots); text('arena-rule-entry', c.entry); text('arena-rule-prize-label', c.prize);
    text('arena-rule-map', c.map); text('arena-rule-gas', c.gas); text('arena-rule-balance', c.balance); text('arena-rule-monsters', c.monsters);
    text('arena-role-title', c.roleTitle); text('arena-role-note', c.roleNote); text('arena-join', c.joinTest); text('arena-online-queue', c.online);
    text('arena-room-title', TEST_BOTS ? c.roomTest : c.roomMatch); text('arena-start', c.start); text('arena-reset', c.reset); text('arena-exit-setup', c.exit); text('arena-menu', c.exit);
    text('arena-battle-title', c.battleTitle); text('arena-battle-note', c.battleNote); text('arena-exit', c.abandon); text('arena-menu-battle', c.exit);
  }

  const state = {
    owned: [],
    selected: null,
    room: [],
    onlineMatch: '',
    onlineSnapshot: null,
    onlineQueueing: false,
    onlineStarting: false,
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
    state.onlineStarting = false;
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
    applyArenaCopy();
    $('arena-join').classList.toggle('hidden', !TEST_BOTS);
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
      opt.textContent = copy().noLegend;
      opt.value = '';
      select.appendChild(opt);
      select.disabled = true;
      $('arena-join').disabled = true;
      $('arena-note').textContent = copy().needLegend;
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
      $('arena-note').textContent = fill(copy().needCoins, ENTRY_COINS);
    } else if (onlineButton && !onlineEnabled()) {
      $('arena-note').textContent = copy().offline;
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
      detail.textContent = '';
      const empty = document.createElement('p'); empty.className = 'note'; empty.textContent = copy().emptyRole; detail.appendChild(empty);
      return;
    }
    cv.style.setProperty('--stage-c', G.U.TYPE_COLOR[mon.types[0]] || '#5b83d6');
    G.UI.sprite(cv, mon.dex, { lively: true, scale: 3, hero: true });
    const pool = G.Moves.poolFor(mon);
    const names = pool.map(id => G.Moves.BY_ID[id]).filter(Boolean).slice(0, 8);
    detail.innerHTML = `
      <div class="arena-role-title"><b>${esc(mon.name)}</b> ${G.UI.stars(mon.rarity, 12)}</div>
      <div class="arena-role-stats">HP ${mon.hp} · ATK ×${mon.atk.toFixed(2)} · SPD ${mon.spd}</div>
      <div class="arena-role-moves"><span class="sub">${esc(copy().skills)}</span> ${names.map(m => `<span class="chip">${esc(m.name)}</span>`).join('')}</div>`;
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
      ? fill(copy().testFull, MAX_PLAYERS - 1)
      : fill(copy().occupied, MAX_PLAYERS, mon.name);
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
      $('arena-note').textContent = copy().assigned;
      void startOnlineMatch();
      return;
    }
    if (result.status === 'queued') {
      state.onlineQueueing = true;
      const position = Math.max(1, Number(result.position) || 1);
      $('arena-count').textContent = fill(copy().queueLabel, position);
      $('arena-start').disabled = true;
      $('arena-note').textContent = fill(copy().queue, position);
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
        $('arena-note').textContent = fill(copy().connectionError, error.message || 'network error');
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
      $('arena-note').textContent = copy().serverError;
      renderRoles();
    }
  }

  function renderRoom() {
    const list = $('arena-slots');
    list.innerHTML = '';
    $('arena-count').textContent = `${state.room.length}/${MAX_PLAYERS}`;
    if (!state.room.length) {
      const empty = document.createElement('p'); empty.className = 'note arena-empty'; empty.textContent = TEST_BOTS ? copy().emptyTest : copy().emptyMatch; list.appendChild(empty);
    } else {
      for (const [i, member] of state.room.entries()) {
        const mon = G.DEX_BY[member.dex];
        const el = document.createElement('div');
        el.className = 'arena-slot' + (member.human ? ' human' : '');
        const c = copy();
        const suffix = member.human ? ` · ${c.self}` : member.online ? ` · ${c.player}` : ` · ${c.bot}`;
        el.innerHTML = `<span class="arena-slot-no">${i + 1}</span><span class="arena-slot-name">${esc(member.name)}${suffix}</span><span class="arena-slot-mon">${esc(mon ? mon.name : '???')}</span>`;
        list.appendChild(el);
      }
    }
    $('arena-start').disabled = state.room.length === 0 || state.onlineQueueing || !!state.onlineMatch;
  }

  async function startOnlineMatch() {
    if (state.onlineStarting) return;
    const snapshot = state.onlineSnapshot;
    const me = snapshot && snapshot.player;
    if (!snapshot || !state.onlineMatch || !me) {
      $('arena-note').textContent = copy().notReady;
      return;
    }
    state.onlineStarting = true;
    $('arena-start').disabled = true;
    $('arena-note').textContent = copy().connecting;
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
      state.onlineStarting = false;
      $('arena-start').disabled = false;
      $('arena-note').textContent = fill(copy().connectionError, error.message || 'network error');
    }
  }

  function startClassicPreview() {
    if (!state.room.length) return;
    if (state.onlineMatch) { startOnlineMatch(); return; }
    const save = G.DB.save || {};
    if (Number(save.coins || 0) < ENTRY_COINS) {
      $('arena-note').textContent = fill(copy().insufficient, ENTRY_COINS);
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
    $('arena-note').textContent = copy().resetNote;
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
    $('arena-exit-setup').onclick = backToMenu;
    $('arena-menu').onclick = backToMenu;
    $('arena-menu-battle').onclick = backToMenu;
    $('arena-death-exit').onclick = () => G.Game.leaveArena();
  }

  init();
  return { open };
})();
