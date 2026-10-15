/* ============ arena.js — arena MVP hooks for the classic game loop ============
 *
 * The arena deliberately reuses Player, Combat, World, Spawner and the normal
 * renderer.  The bots below are only a local test fixture: the production
 * room will replace them with network players and pass testBots: false.
 *
 * They are not an autonomous second game.  They move inside the real map,
 * use moves from each Pokémon's compatible pool, cast the normal VFX, and
 * resolve a lightweight player-vs-player hit check beside the normal PvE
 * collision code.
 */
G.Arena = (() => {
  const BOT_NAMES = ['Rival-01', 'Rival-02', 'Rival-03', 'Rival-04', 'Rival-05', 'Rival-06', 'Rival-07'];
  const ATTACK_KINDS = new Set(['projectile', 'melee', 'beam', 'nova', 'aura', 'boomerang',
    'chain', 'mine', 'meteor', 'turret', 'dash', 'trail', 'cone']);
  const AREA_KINDS = new Set(['melee', 'nova', 'aura', 'mine', 'meteor', 'turret', 'trail']);
  const TARGET_KINDS = new Set(['projectile', 'melee', 'beam', 'boomerang', 'chain', 'meteor', 'dash', 'cone']);
  // Match the validated offline model. PvE damage remains unchanged.
  const PVP_DAMAGE_SCALE = G.ArenaBalance?.damageScale || 0.72;
  const BALANCE_VERSION = G.ArenaBalance?.version || 'sim-100k-v3';
  const LEGENDARIES = G.DEX.filter(mon => mon.rarity === 5);

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  const MEDIAN = {
    hp: median(LEGENDARIES.map(mon => mon.hp)),
    spd: median(LEGENDARIES.map(mon => mon.spd)),
    atk: median(LEGENDARIES.map(mon => mon.atk))
  };

  function scaledStat(raw, center, exponent = 0.35) {
    return center * Math.pow(Math.max(0.01, raw / center), exponent);
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function balanceRow(mon) {
    const tuned = G.ArenaBalance?.roles?.[mon.dex] || { multiplier: 1 };
    const multiplier = Number(tuned.multiplier) || 1;
    return {
      hp: Math.round(scaledStat(mon.hp, MEDIAN.hp) * Math.pow(multiplier, 0.52)),
      atk: Number((scaledStat(mon.atk, MEDIAN.atk) * Math.pow(multiplier, 0.76)).toFixed(3)),
      spd: Math.round(scaledStat(mon.spd, MEDIAN.spd)),
      multiplier
    };
  }

  // Materialize the complete 103-role table once, so every participant uses
  // the same deterministic values on every local test run.
  const ARENA_BALANCE = Object.fromEntries(
    G.DEX.filter(mon => mon.rarity === 5).map(mon => [mon.dex, balanceRow(mon)])
  );

  function applyRoleBalance(player) {
    const row = ARENA_BALANCE[player.mon.dex] || balanceRow(player.mon);
    player.arenaBalance = { version: BALANCE_VERSION, ...row };
    // Arena tests compare roles, not permanent PvE upgrade investment.
    player.atkMul = 1;
    player.spdMul = 1;
    player.dmgReduce = 0;
    player.regenFlat = 0;
    player.baseAtk = row.atk;
    player.baseSpd = row.spd;
    player.maxHp = row.hp;
    player.hp = row.hp;
  }
  // The Arena is a finite battle royale map, not the open-ended classic map.
  // World units are 32 px per tile; 48 tiles gives a 96-tile diameter with
  // enough room for eight players to spread out before the gas closes in.
  const ARENA_RADIUS_TILES = 48;
  const ARENA_SPAWN_MARGIN_TILES = 4;
  const ARENA_TYPE = 'normal';
  const GAS_START = 600;
  const FRENZY_START = 660;
  const SPAWN_DIRECTIONS = [
    -Math.PI / 2, -Math.PI / 4, 0, Math.PI / 4,
    Math.PI / 2, Math.PI * 0.75, Math.PI, -Math.PI * 0.75
  ];

  let active = false;
  let config = null;
  let human = null;
  let bots = [];
  let remotePlayers = [];
  let clock = 0;
  let center = { x: 0, y: 0 };
  let deathShown = false;
  let resultShown = false;
  let settled = false;
  let feedbackReported = false;
  let scoreboardT = 0;
  let onlineStateT = 0;
  let onlineSeq = 0;

  function all() { return human ? [human, ...bots, ...remotePlayers] : [...bots, ...remotePlayers]; }
  function alive() { return all().filter(p => p && !p.dead); }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>\"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  // This is intentionally a DOM HUD instead of a second canvas panel. The
  // normal game canvas is resized and transformed by the camera, while this
  // panel must stay fixed to the left side of the screen.
  function renderScoreboard() {
    const el = document.getElementById('arena-hud-scoreboard');
    if (!el) return;
    if (!active) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    const list = all().filter(Boolean).slice().sort((a, b) =>
      Number(a.dead) - Number(b.dead)
      || (b.level || 1) - (a.level || 1)
      || (b.arenaKills || 0) - (a.arenaKills || 0)
      || (a.arenaSlot == null ? 99 : a.arenaSlot) - (b.arenaSlot == null ? 99 : b.arenaSlot));
    const aliveCount = list.filter(p => !p.dead).length;
    el.innerHTML = `
      <div class="arena-hud-title"><span>ARENA · 房间 ${list.length}/8</span><b>存活 ${aliveCount}</b></div>
      <div class="arena-hud-header"><span>#</span><span>玩家</span><span>等级 · KO · HP</span></div>
      ${list.map((p, i) => {
        const own = p === human;
        const name = own ? 'TÚ' : (p.arenaName || p.mon?.name || 'Rival');
        const state = p.dead ? '淘汰' : `Lv.${p.level || 1} · ${p.arenaKills || 0}`;
        const hp = own && !p.dead ? Math.round(clamp((p.hp / Math.max(1, p.maxHp)) * 100, 0, 100)) : null;
        const hpMarkup = hp == null ? '' : `<small class="arena-hud-hp">HP ${Math.ceil(p.hp)}/${Math.round(p.maxHp)} · ${hp}%</small><span class="arena-hud-hpbar"><i style="width:${hp}%"></i></span>`;
        return `<div class="arena-hud-row${p.dead ? ' out' : ''}${own ? ' me' : ''}">
          <span class="arena-hud-rank">${i + 1}</span>
          <span class="arena-hud-name"><b>${escapeHtml(name)}</b><small>${p.dead ? 'OUT' : (p.arenaMarker === 'IA' ? 'IA' : '玩家')}</small></span>
          <span class="arena-hud-state"><span>${escapeHtml(state)}</span>${hpMarkup}</span>
        </div>`;
      }).join('')}`;
    el.classList.remove('hidden');
  }

  function ownMove(bot) {
    const moves = bot.moves.filter(m => ATTACK_KINDS.has(m.kind));
    if (!moves.length) return bot.activeMove();
    return moves[(Math.floor(clock * 0.7) + bot.arenaSlot) % moves.length];
  }

  function nearestEnemy(from) {
    let best = null, bd = Infinity;
    for (const p of all()) {
      if (!p || p === from || p.dead) continue;
      const d = G.U.dist2(from.x, from.y, p.x, p.y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  // A wall must block Arena attacks just like it blocks movement.  The normal
  // projectile resolver already does this for projectile sprites, but Arena
  // PvP damage is resolved directly below and therefore needs the same check.
  // Sampling the segment also catches a wall tile when the attacker and the
  // target are both close to opposite corners of that tile.
  function hasLineOfSight(from, to, radius = 4) {
    if (!from || !to || !G.World?.projectileBlock) return true;
    const dx = to.x - from.x, dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    const steps = Math.max(2, Math.ceil(distance / 12));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const blocked = G.World.projectileBlock(from.x + dx * t, from.y + dy * t, radius);
      if (blocked) return false;
    }
    return true;
  }

  function randomLegend(i) {
    const pool = G.DEX.filter(p => p.rarity === 5);
    return pool.length ? pool[i % pool.length] : G.DEX[0];
  }

  function spawnPoint(slot, bodyRadius = 18) {
    const a = SPAWN_DIRECTIONS[slot % SPAWN_DIRECTIONS.length];
    const ts = G.World.TS || 32;
    const outer = Math.max(ts, (ARENA_RADIUS_TILES - ARENA_SPAWN_MARGIN_TILES) * ts);
    // Start at the outer ring and move inward only when a deterministic
    // wall/prop happens to occupy that exact tile. This keeps each player as
    // far from the center as the finite map safely allows.
    for (let i = 0; i <= 8; i++) {
      const radius = outer - i * ts * 0.6;
      const point = { x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius };
      if (G.World.isFree(point.x, point.y, bodyRadius + 4)) return point;
    }
    return { x: center.x + Math.cos(a) * outer, y: center.y + Math.sin(a) * outer };
  }

  function addBot(i) {
    const mon = randomLegend(i * 3 + 1);
    const perks = G.Upgrades.perks(G.DB.upgradesOf(mon.dex));
    const bot = new G.Player(mon, perks, false);
    applyRoleBalance(bot);
    bot.remote = true;
    bot.arenaBot = true;
    bot.uid = 'arena-bot-' + (i + 1);
    bot.arenaSlot = i + 1;
    bot.arenaName = BOT_NAMES[i] || ('Rival-' + String(i + 1).padStart(2, '0'));
    bot.tag = bot.arenaName;
    bot.tagColor = '#7fe0ff';
    bot.arenaMarker = 'IA';
    bot.arenaAttackT = 0.9 + i * 0.12;
    bot.arenaKills = 0;
    bot.arenaDamage = 0;
    bot.arenaLastHitBy = null;

    // Keep every move inside this Pokémon's own type/normal compatibility
    // pool.  Bots get a compact test loadout; the human keeps the real level-up flow.
    const ids = [G.Moves.startFor(mon), ...G.Moves.poolFor(mon)
      .filter(id => id !== G.Moves.startFor(mon) && G.Moves.BY_ID[id]
        && ATTACK_KINDS.has(G.Moves.BY_ID[id].kind))];
    for (const id of ids.slice(0, 4)) bot.addMove(id);
    bot.setActive(0);

    const point = spawnPoint(i + 1, bot.r);
    bot.x = point.x;
    bot.y = point.y;
    G.World.collide(bot);
    return bot;
  }

  // Network players are renderable Player objects, but their simulation is
  // owned by the remote client/server. We only interpolate the last validated
  // snapshot and never run their PvE loop locally.
  function addRemote(member, fallbackIndex) {
    const mon = G.DEX_BY[Number(member.dex)] || randomLegend(fallbackIndex + 11);
    const remote = new G.Player(mon, G.Upgrades.perks({}), !!member.shiny);
    applyRoleBalance(remote);
    remote.remote = true;
    remote.arenaRemote = true;
    remote.uid = String(member.uid || '');
    remote.arenaSlot = Number.isInteger(Number(member.seat)) ? Number(member.seat) : fallbackIndex;
    remote.arenaName = String(member.name || 'Jugador').slice(0, 40);
    remote.tag = remote.arenaName;
    remote.tagColor = '#8fe9ff';
    remote.arenaMarker = 'Jugador';
    remote.arenaKills = Math.max(0, Number(member.kills) || 0);
    remote.arenaDamage = Math.max(0, Number(member.damage) || 0);
    remote.dead = ['dead', 'withdrawn'].includes(member.status);
    remote._arenaStatus = member.status || 'reserved';
    const ids = [G.Moves.startFor(mon), ...G.Moves.poolFor(mon)
      .filter(id => id !== G.Moves.startFor(mon) && G.Moves.BY_ID[id]
        && ATTACK_KINDS.has(G.Moves.BY_ID[id].kind))];
    for (const id of ids.slice(0, 4)) remote.addMove(id);
    remote.setActive(0);
    const point = spawnPoint(remote.arenaSlot, remote.r);
    remote.x = point.x;
    remote.y = point.y;
    G.World.collide(remote);
    return remote;
  }

  function applyRemoteState(state) {
    if (!active || !state || !state.uid) return;
    const remote = remotePlayers.find(p => p.uid === String(state.uid));
    if (!remote) return;
    const ts = G.World.TS || 32;
    const limit = (ARENA_RADIUS_TILES - 1) * ts;
    const x = Number(state.x), y = Number(state.y);
    if (Number.isFinite(x)) remote.x = clamp(x, center.x - limit, center.x + limit);
    if (Number.isFinite(y)) remote.y = clamp(y, center.y - limit, center.y + limit);
    remote.hp = clamp(Number(state.hp) || 0, 0, remote.maxHp);
    remote.level = clamp(Math.floor(Number(state.level) || 1), 1, 200);
    remote.arenaKills = clamp(Math.floor(Number(state.kills) || 0), 0, 7);
    remote.arenaDamage = clamp(Number(state.damage) || 0, 0, 1e8);
    const wasDead = remote.dead;
    remote.dead = !!state.dead;
    remote._arenaStatus = remote.dead ? 'dead' : 'playing';
    if (remote.dead && !wasDead) remote.anim.play('Faint', { hold: true });
    if (!remote.dead && wasDead) remote.anim.loop('Idle');
    remote.walking = false;
    remote.anim.update(0.016);
  }

  function applyRemoteAction(uid, action) {
    if (!active || !action) return;
    const remote = remotePlayers.find(p => p.uid === String(uid));
    if (!remote || remote.dead) return;
    const aim = Number(action.aim);
    if (Number.isFinite(aim)) remote.aim = clamp(aim, -Math.PI * 4, Math.PI * 4);
    const move = remote.moves.find(m => m.id === String(action.move || '')) || remote.activeMove();
    if (!move) return;
    const slot = remote.slots.findIndex(group => group.includes(move));
    if (slot >= 0) remote.active = slot;
    // Show the same attack animation and resolve the predicted PvP hit locally.
    // The server still decides the durable player state and settlement.
    remote.cast(move);
    applyMove(remote, move);
  }

  function start(options, player) {
    stop();
    config = Object.assign({ maxPlayers: 8, testBots: true, botCount: 7, online: false,
      matchId: '', playerSeat: 0, remotePlayers: [], initialElapsed: 0 }, options || {});
    config.botCount = Math.max(0, Math.min(config.maxPlayers - 1, config.botCount | 0));
    human = player;
    active = true;
    clock = Math.max(0, Number(config.initialElapsed) || 0);
    // The world is reset before this hook. Use the center tile explicitly so
    // the eight spawn points are stable across clients and test runs.
    const ts = G.World.TS || 32;
    center = { x: ts / 2, y: ts / 2 };
    G.World.setArena({ tx: 0, ty: 0, r: ARENA_RADIUS_TILES, type: ARENA_TYPE });
    G.World.setBiome(G.Tiles.arenaBiome(ARENA_TYPE), true);
    deathShown = false;
    resultShown = false;
    settled = false;
    feedbackReported = false;
    scoreboardT = 0;
    onlineStateT = 0;
    onlineSeq = 0;
    player.arenaSlot = Number.isInteger(Number(config.playerSeat)) ? Number(config.playerSeat) : 0;
    player.uid = String(G.DB?.fb?.uid || G.DB?.fb?.auth?.currentUser?.uid || '');
    player.arenaName = G.DB.save.name || 'Tú';
    player.tag = 'TÚ';
    player.tagColor = '#ffd23f';
    player.arenaMarker = 'TÚ';
    player.arenaKills = 0;
    player.arenaDamage = 0;
    player.arenaDamageTaken = 0;
    player.arenaPveKills = 0;
    player.arenaSkillCasts = 0;
    player.arenaLastHitBy = null;
    applyRoleBalance(player);

    // Eight deterministic compass/diagonal positions: N, NE, E, SE, S, SW,
    // W and NW. The human occupies slot 1 and bots fill the remaining slots.
    const humanPoint = spawnPoint(player.arenaSlot, player.r);
    player.x = humanPoint.x;
    player.y = humanPoint.y;
    G.World.collide(player);

    if (config.testBots !== false) {
      for (let i = 0; i < config.botCount; i++) bots.push(addBot(i));
    }
    if (config.online && Array.isArray(config.remotePlayers)) {
      remotePlayers = config.remotePlayers
        .filter(member => member && String(member.uid || '') !== String(player.uid || ''))
        .slice(0, Math.max(0, config.maxPlayers - 1))
        .map((member, i) => addRemote(member, i + 1));
    }
    renderScoreboard();
  }

  function stop() {
    if (config && config.online && G.ArenaOnline && G.ArenaOnline.active) G.ArenaOnline.close();
    // Restore the open procedural world for classic mode/background preview.
    if (G.World) {
      G.World.setArena(null);
      G.World.setBiome(0, true);
    }
    active = false;
    config = null;
    human = null;
    bots = [];
    remotePlayers = [];
    clock = 0;
    deathShown = false;
    resultShown = false;
    settled = false;
    feedbackReported = false;
    scoreboardT = 0;
    onlineStateT = 0;
    onlineSeq = 0;
    renderScoreboard();
  }

  function directedHit(attacker, target, m) {
    if (!hasLineOfSight(attacker, target, 4)) return false;
    const dx = target.x - attacker.x, dy = target.y - attacker.y;
    const d = Math.hypot(dx, dy);
    const reach = m.kind === 'melee' ? m.radius + 30
      : m.kind === 'beam' ? m.radius + 20
      : m.kind === 'boomerang' ? m.radius + 40
      : m.kind === 'chain' ? 280
      : m.kind === 'meteor' ? 340
      : m.kind === 'dash' ? m.radius + 60
      : m.kind === 'cone' ? m.speed * m.life + 30 : 520;
    if (d > reach + target.r) return false;
    if (m.kind === 'beam' || m.kind === 'cone' || m.kind === 'melee') {
      const a = Math.atan2(dy, dx);
      const half = m.kind === 'beam' ? 0.12 : Math.min(m.arc || 1.2, 6.2832) / 2;
      const delta = Math.abs(((a - attacker.aim + Math.PI * 3) % 6.2832) - Math.PI);
      if (delta > half) return false;
    }
    return true;
  }

  function applyDamage(attacker, target, m) {
    if (!target || target.dead || target === attacker) return;
    // Player.hurt applies the type chart and weather modifier once; keep the
    // arena scaling separate so super-effective hits are not multiplied twice.
    const rawType = m.type && target.mon?.types ? G.Types.mult(m.type, target.mon.types) : 1;
    const typeK = m.type ? clamp(Math.sqrt(Math.max(0, rawType)), 0.76, 1.34) : 1;
    const base = Math.max(1, (m.dmg || 1) * attacker.atk * typeK * PVP_DAMAGE_SCALE);
    target.arenaLastHitBy = attacker;
    // Type effectiveness is already softened above; passing the type again to
    // Player.hurt would apply the normal PvE chart a second time.
    target.hurt(base, null);
    attacker.arenaDamage = (attacker.arenaDamage || 0) + base;
    target.arenaDamageTaken = (target.arenaDamageTaken || 0) + base;
    if (target.dead && !target.arenaEliminated) {
      target.arenaEliminated = true;
      attacker.arenaKills = (attacker.arenaKills || 0) + 1;
      G.FX.dmgText(target.x, target.y - target.bodyH - 20, 'KO', '#ffd23f', true);
    }
  }

  function applyMove(attacker, m) {
    if (!m || m.kind === 'buff') return;
    const candidates = alive().filter(p => p !== attacker);
    if (!candidates.length) return;
    if (AREA_KINDS.has(m.kind)) {
      const radius = Math.max(54, m.radius || (m.kind === 'aura' ? 120 : 90));
      for (const target of candidates) {
        if (hasLineOfSight(attacker, target, 4)
          && G.U.dist2(attacker.x, attacker.y, target.x, target.y) <= (radius + target.r) ** 2) {
          applyDamage(attacker, target, m);
        }
      }
      return;
    }
    let target = null, bd = Infinity;
    for (const p of candidates) {
      if (!directedHit(attacker, p, m)) continue;
      const d = G.U.dist2(attacker.x, attacker.y, p.x, p.y);
      if (d < bd) { bd = d; target = p; }
    }
    if (target) applyDamage(attacker, target, m);
  }

  function removeGhostProjectiles(bot) {
    for (const p of G.Projectiles.all().slice()) {
      if (p.owner === bot && p.ghost) G.Projectiles.remove(p);
    }
  }

  function castBot(bot, m, target) {
    // Do not even show a bot attack that cannot reach the target because of a
    // wall. The bot will keep moving and can attack once it goes around it.
    if (!hasLineOfSight(bot, target, 4)) return;
    bot.aim = Math.atan2(target.y - bot.y, target.x - bot.x);
    // Reuse the real skill VFX, but do not let a local test bot damage PvE
    // through the ordinary projectile resolver.
    if (m.kind !== 'orbit') G.Combat.ghostCast(bot, m.id, m.lvl, bot.aim, false);
    else {
      bot.cast(m);
      G.FX.ring(bot.x, bot.y, bot.r, Math.max(70, m.radius || 90), G.U.TYPE_COLOR[m.type], 0.25, 2);
    }
    removeGhostProjectiles(bot);
    applyMove(bot, m);
  }

  function updateBot(bot, dt, now) {
    if (bot.dead) { bot.anim.update(dt); return; }
    bot.invuln = Math.max(0, bot.invuln - dt);
    bot.flash = Math.max(0, bot.flash - dt);
    bot.slowT = Math.max(0, bot.slowT - dt);
    const target = nearestEnemy(bot);
    if (!target) {
      bot.walking = false;
      bot.anim.loop('Idle');
      bot.anim.update(dt);
      return;
    }
    const dx = target.x - bot.x, dy = target.y - bot.y;
    const d = Math.hypot(dx, dy) || 1;
    const move = ownMove(bot);
    const ideal = move && (move.kind === 'melee' || move.kind === 'aura' || move.kind === 'nova') ? 86 : 210;
    const toward = d > ideal ? 1 : d < ideal * 0.55 ? -0.65 : 0.18;
    const strafe = Math.sin(now * 1.35 + bot.arenaSlot * 1.7) * 0.34;
    const nx = dx / d, ny = dy / d;
    const vx = (nx * toward - ny * strafe) * bot.spd;
    const vy = (ny * toward + nx * strafe) * bot.spd;
    bot.x += vx * dt; bot.y += vy * dt;
    G.World.collide(bot);
    bot.walking = Math.abs(vx) + Math.abs(vy) > 1;
    bot.moveAngle = Math.atan2(vy, vx);
    bot.aim = Math.atan2(dy, dx);
    bot.anim.dir = G.Sprites.dirFromAngle(bot.aim);
    bot.anim.loop(bot.walking ? 'Walk' : 'Idle', bot.walking ? bot.spd / 110 : 1);
    bot.anim.update(dt);

    bot.arenaAttackT -= dt;
    if (bot.arenaAttackT <= 0 && move) {
      bot.arenaAttackT = Math.max(0.38, (move.cd || 1) * bot.cdMul) * (0.85 + (bot.arenaSlot % 3) * 0.08);
      castBot(bot, move, target);
    }
  }

  function gasTick(dt) {
    if (clock < GAS_START) return;
    const frenzy = clock >= FRENZY_START;
    for (const p of alive()) {
      // The whole map is covered at 10:00.  The final 60 seconds deal double
      // damage, and no player receives a reconnect/invulnerability exception.
      p.hurt(p.maxHp * (frenzy ? 0.05 : 0.025) * dt, 'poison');
    }
  }

  function chooseTieWinner() {
    return all().filter(Boolean).sort((a, b) =>
      (b.arenaKills || 0) - (a.arenaKills || 0)
      || (b.arenaDamage || 0) - (a.arenaDamage || 0)
      || (a.arenaSlot == null ? 99 : a.arenaSlot) - (b.arenaSlot == null ? 99 : b.arenaSlot))[0] || null;
  }

  function settleMatch(winner) {
    if (settled || !human || !config || !config.arenaEntryPaid) return 0;
    settled = true;
    if (config.online) return 0;
    if (winner !== human) return 0;
    const payout = Math.max(0, Number(config.winnerPayout) || 0);
    if (!payout || !G.DB?.save) return 0;
    G.DB.save.coins = Math.max(0, Number(G.DB.save.coins || 0) + payout);
    G.DB.commit();
    human.arenaPayout = payout;
    return payout;
  }

  function reportPlayerOutcome(winner) {
    if (feedbackReported || !human) return;
    const outcome = winner === human ? 'win' : human.dead ? 'loss' : '';
    if (!outcome) return;
    feedbackReported = true;
    if (config && config.online && config.matchId && G.ArenaOnline) {
      const eventType = outcome === 'win' ? 'win' : 'dead';
      const eventId = `outcome-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      G.ArenaOnline.report({
        eventType,
        eventId,
        elapsedSec: Math.floor(clock),
        level: Number(human.level) || 1,
        kills: Number(human.arenaKills) || 0,
        damage: Number(human.arenaDamage) || 0,
        damageTaken: Number(human.arenaDamageTaken) || 0,
        pveKills: Number(human.arenaPveKills) || 0,
        skillCasts: Number(human.arenaSkillCasts) || 0
      }).then(result => {
        // The online save is charged before matchmaking. Refresh after the
        // outcome so both loser and winner see the server ledger result.
        const savePromise = G.DB && G.DB.applyServerSave
          ? G.DB.applyServerSave(result && result.save || {})
          : Promise.resolve();
        return savePromise.then(() => {
          if (result && result.reward && result.reward.granted) {
            G.UI.toast('¡Primera partida completada! Has recibido 1 ticket amarillo.', 4200);
            if (G.UI && G.UI.refreshCoins) G.UI.refreshCoins();
            if (G.GachaUI && G.GachaUI.refresh) G.GachaUI.refresh();
          }
          return result;
        });
      }).catch(error => console.warn('[Arena] outcome report failed', error));
    }
    if (G.ArenaFeedback) G.ArenaFeedback.recordMatch({
      outcome,
      durationSec: Math.max(0, Math.floor(clock)),
      level: Number(human.level) || 1,
      roleDex: Number(human.mon?.dex) || 0,
      balanceVersion: human.arenaBalance?.version || BALANCE_VERSION
    });
  }

  function showResult(winner) {
    if (resultShown || !human) return;
    reportPlayerOutcome(winner);
    const title = document.getElementById('arena-death-title');
    const note = document.getElementById('arena-death-note');
    // Show an immediate elimination notice, but keep the result provisional
    // while the other bots are still fighting so the final winner can update it.
    if (!winner) {
      if (title) title.textContent = 'Has sido eliminado';
      if (note) note.textContent = 'La partida continúa para los supervivientes. Puedes salir de la sala. La cuota de entrada no se reembolsa.';
      G.UI.show('scr-arena-death');
      return;
    }
    const payout = settleMatch(winner);
    resultShown = true;
    if (title) title.textContent = winner === human ? '¡Has ganado!' : 'Has sido eliminado';
    if (note) {
      const name = winner ? (winner.arenaName || winner.mon.name) : 'nadie';
      note.textContent = winner === human
        ? config?.online
          ? 'Eres el último superviviente. El servidor está confirmando el premio. Puedes salir de la sala.'
          : `Eres el último superviviente. Premio de prueba: +${payout} monedas. Puedes salir de la sala cuando quieras.`
        : `Ganador de la prueba: ${name}. Puedes salir de la sala.`;
    }
    G.UI.show('scr-arena-death');
  }

  // 普通 PvE 伤害可能发生在 Arena.update() 之后的同一帧。这个兜底让
  // 玩家死亡后无论由 PvP、怪物还是毒气造成，都一定能看到离开房间按钮。
  function showEliminationExit() {
    if (!active || !human || !human.dead || G.UI.isOpen('scr-arena-death')) return;
    const title = document.getElementById('arena-death-title');
    const note = document.getElementById('arena-death-note');
    if (title) title.textContent = 'Has sido eliminado';
    if (note) note.textContent = 'La partida continúa para los supervivientes. Puedes salir de la sala. La cuota de entrada no se reembolsa.';
    G.UI.show('scr-arena-death');
  }

  function update(dt, now, player) {
    if (!active) return;
    clock = now;
    scoreboardT -= dt;
    if (scoreboardT <= 0) {
      scoreboardT = 0.15;
      renderScoreboard();
    }
    if (config && config.online && G.ArenaOnline && player) {
      onlineStateT -= dt;
      if (onlineStateT <= 0) {
        onlineStateT = 0.1;
        G.ArenaOnline.sendState({
          seq: ++onlineSeq,
          x: Number(player.x) || 0,
          y: Number(player.y) || 0,
          hp: Math.max(0, Number(player.hp) || 0),
          maxHp: Math.max(1, Number(player.maxHp) || 1),
          level: Number(player.level) || 1,
          kills: Number(player.arenaKills) || 0,
          damage: Number(player.arenaDamage) || 0,
          damageTaken: Number(player.arenaDamageTaken) || 0,
          pveKills: Number(player.arenaPveKills) || 0,
          skillCasts: Number(player.arenaSkillCasts) || 0,
          dead: !!player.dead
        });
      }
    }
    // Classic mode auto-aims at the nearest threat. In Arena, give that same
    // rule a PvP target when a rival is in skill range, without changing WASD
    // or the player's normal skill buttons.
    if (player && !player.dead) {
      const rival = nearestEnemy(player);
      if (rival && G.U.dist(player.x, player.y, rival.x, rival.y) <= 520) {
        player.target = rival;
        player.aim = Math.atan2(rival.y - player.y, rival.x - player.x);
      }
    }
    for (const bot of bots) updateBot(bot, dt, now);
    for (const remote of remotePlayers) {
      if (!remote.dead) remote.anim.loop('Idle');
      remote.anim.update(dt);
    }
    gasTick(dt);
    const living = alive();
    if (player.dead && !deathShown) {
      deathShown = true;
      showResult(living.length === 1 ? living[0] : null);
    }
    if (living.length <= 1) showResult(living[0] || chooseTieWinner());
    if (clock >= FRENZY_START && living.length > 1) {
      // A simultaneous gas death is resolved by kills, damage, then seat; the
      // deterministic result prevents two clients from selecting differently.
      const stillAlive = alive();
      if (stillAlive.length > 1) showResult(chooseTieWinner());
    }
  }

  function onCast(attacker, move) {
    if (!active || !attacker || attacker.dead || attacker !== human) return;
    attacker.arenaSkillCasts = (attacker.arenaSkillCasts || 0) + 1;
    applyMove(attacker, move);
    if (config && config.online && G.ArenaOnline) {
      G.ArenaOnline.sendAction({
        seq: ++onlineSeq,
        move: move.id,
        lvl: move.lvl,
        aim: attacker.aim,
        at: Math.floor(clock * 1000)
      });
    }
  }

  function onOrbit(attacker, move, dt) {
    if (!active || !attacker || attacker.dead) return;
    attacker._arenaOrbitT = (attacker._arenaOrbitT || 0) - dt;
    if (attacker._arenaOrbitT > 0) return;
    attacker._arenaOrbitT = 0.42;
    applyMove(attacker, move);
  }

  function draw(ctx, w, h) {
    if (!active) return;
    if (clock >= GAS_START) {
      const frenzy = clock >= FRENZY_START;
      ctx.save();
      ctx.fillStyle = frenzy ? 'rgba(126, 24, 145, .32)' : 'rgba(75, 25, 105, .18)';
      ctx.fillRect(0, 0, w, h);
      ctx.textAlign = 'center';
      ctx.font = '700 16px Pixelify, monospace';
      ctx.fillStyle = frenzy ? '#ff8be8' : '#d8b7ff';
      ctx.fillText(frenzy ? 'GAS FURIOSO ×2 · ¡ÚLTIMOS 60 s!' : 'GAS FURIOSO · TODO EL MAPA CUBIERTO', w / 2, 30);
      ctx.restore();
    }
  }

  // Panel de información fijo: crea tensión sin revelar HP ni posición.
  function drawScoreboard(ctx) {
    const list = all().filter(Boolean).slice().sort((a, b) =>
      Number(a.dead) - Number(b.dead)
      || (b.level || 1) - (a.level || 1)
      || (b.arenaKills || 0) - (a.arenaKills || 0)
      || (a.arenaSlot == null ? 99 : a.arenaSlot) - (b.arenaSlot == null ? 99 : b.arenaSlot));
    if (!list.length) return;

    const rowH = 21;
    const panelW = 198;
    const panelX = 10;
    const panelY = 10;
    const panelH = 56 + list.length * rowH;
    const aliveCount = list.filter(p => !p.dead).length;

    ctx.save();
    ctx.fillStyle = 'rgba(5, 13, 35, .84)';
    ctx.strokeStyle = 'rgba(127, 224, 255, .62)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(panelX, panelY, panelW, panelH, 7);
    ctx.fill(); ctx.stroke();

    ctx.textAlign = 'left';
    ctx.font = '700 13px Pixelify, monospace';
    ctx.fillStyle = '#ffd23f';
    ctx.fillText(`Vivos ${aliveCount}/${list.length}`, panelX + 10, panelY + 19);
    ctx.font = '700 11px Pixelify, monospace';
    ctx.fillStyle = 'rgba(232, 240, 255, .62)';
    ctx.fillText('NOMBRE                 NIVEL   KO', panelX + 10, panelY + 34);

    list.forEach((p, i) => {
      const y = panelY + 51 + i * rowH;
      const own = p === human;
      const name = own ? 'TÚ' : (p.arenaName || p.mon?.name || 'Rival');
      const clipped = name.length > 17 ? name.slice(0, 16) + '…' : name;
      ctx.font = '700 12px Pixelify, monospace';
      ctx.fillStyle = p.dead ? 'rgba(232, 240, 255, .38)' : own ? '#ffd23f' : '#f4f8ff';
      ctx.fillText(clipped, panelX + 10, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = p.dead ? 'rgba(232, 240, 255, .32)' : own ? '#ffd23f' : '#a9dcff';
      ctx.fillText(p.dead ? 'KO' : `Lv.${p.level || 1}`, panelX + 166, y);
      ctx.fillStyle = p.dead ? 'rgba(232, 240, 255, .32)' : '#d9e5ff';
      ctx.fillText(String(p.arenaKills || 0), panelX + 188, y);
      ctx.textAlign = 'left';
    });
    ctx.restore();
  }

  return {
    start, stop, update, onCast, onOrbit, draw, showEliminationExit,
    hasLineOfSight, applyRemoteState, applyRemoteAction,
    players: () => bots.slice(),
    everyone: all,
    get active() { return active; },
    get clock() { return clock; },
    get config() { return config; }
  };
})();
