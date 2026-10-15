/*
 * Offline PvP balance simulator.
 *
 * This file intentionally does not import the browser, Firebase, Cloudflare or
 * D1 code. It loads only the static Pokédex/move definitions and runs a small
 * deterministic Monte-Carlo model locally.
 *
 * Run:
 *   node tools/arena-balance-sim.mjs
 *   node tools/arena-balance-sim.mjs --matches 8000 --iterations 10
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (!token.startsWith('--')) continue;
  const [key, inline] = token.slice(2).split('=', 2);
  args.set(key, inline ?? process.argv[++i]);
}

const MATCHES = Math.max(500, Number(args.get('matches') || 5000));
const ITERATIONS = Math.max(1, Number(args.get('iterations') || 9));
const TICK = 0.5;
const PLAYERS = 8;
const SAFE_SECONDS = 600;
const FRENZY_SECONDS = 60;
const TOTAL_SECONDS = SAFE_SECONDS + FRENZY_SECONDS;
const BASE_SEED = 0x6f6b6573;
const TUNING_SEEDS = [BASE_SEED, BASE_SEED ^ 0xa5a5a5a5];
const VALIDATION_SEED = BASE_SEED ^ 0xc3c3c3c3;
const TARGET_WIN_RATE = 1 / PLAYERS;
const TARGET_TOP3_RATE = 3 / PLAYERS;
const TARGET_HITS_TO_KILL = 5;
const ARENA_DAMAGE_SCALE = 0.72;
const RANDOM_SKILL_RATE = 0.35;

function loadGameData() {
  const ctx = { G: { U: { clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)) } } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/data/pokedex.js'), 'utf8'), ctx, { filename: 'pokedex.js' });
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/data/types.js'), 'utf8'), ctx, { filename: 'types.js' });
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/data/moves.js'), 'utf8'), ctx, { filename: 'moves.js' });
  return ctx.G;
}

const G = loadGameData();
const ROSTER = G.DEX.filter(mon => mon.rarity === 5).sort((a, b) => a.dex - b.dex);
if (ROSTER.length !== 103) throw new Error(`Expected 103 rarity-5 roles, found ${ROSTER.length}`);

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return (x >>> 0) / 4294967296;
  };
}

function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const MEDIAN = {
  hp: median(ROSTER.map(m => m.hp)),
  spd: median(ROSTER.map(m => m.spd)),
  atk: median(ROSTER.map(m => m.atk))
};

const KIND = {
  projectile: { range: 460, hit: 0.70, hits: m => Math.max(1, m.count || 1) * (1 + (m.pierce || 0) * 0.14) },
  melee:      { range: m => Math.max(65, m.radius || 60), hit: 0.88, hits: () => 1.0 },
  beam:       { range: m => Math.max(110, m.radius || 100), hit: 0.82, hits: () => 1.0 },
  orbit:      { range: m => Math.max(75, (m.radius || 60) + 25), hit: 0.76, hits: m => Math.max(1, m.count || 1) * 0.80 },
  nova:       { range: 180, hit: 0.68, hits: m => Math.max(3, m.count || 3) * 0.34 },
  aura:       { range: m => Math.max(75, m.radius || 70), hit: 0.74, hits: () => 0.85 },
  boomerang:  { range: m => Math.max(130, m.radius || 180), hit: 0.70, hits: m => Math.max(1, m.count || 1) * 1.35 },
  chain:      { range: m => Math.max(170, m.radius || 150), hit: 0.78, hits: m => 1 + Math.min(4, m.count || 1) * 0.42 },
  mine:       { range: 145, hit: 0.56, hits: m => Math.max(1, m.count || 1) * 0.70 },
  meteor:     { range: 330, hit: 0.68, hits: m => Math.max(1, m.count || 1) * 0.68 },
  turret:     { range: m => Math.max(170, m.range || 280), hit: 0.66, hits: m => Math.max(1, m.count || 1) * Math.min(7, (m.dur || 6) / (m.rate || 0.6)) * 0.55 },
  dash:       { range: m => Math.max(100, m.radius || 110), hit: 0.72, hits: () => 1.0 },
  trail:      { range: 100, hit: 0.60, hits: m => Math.max(1, (m.dur || 2.5) / 0.5) * 0.45 },
  cone:       { range: m => Math.max(90, (m.speed || 300) * (m.life || 0.4)), hit: 0.48, hits: m => Math.max(2, m.count || 2) * 0.42 },
};

// The arena needs a common opening action. If each role enters with its PvE
// starter move unchanged, projectile/beam roles can damage opponents before
// melee roles can ever interact with them. The real mode can skin this as a
// light neutral attack; character-specific identity then comes from the
// progressively unlocked moves below.
const ARENA_BASIC = {
  id: 'arena-basic',
  kind: 'projectile',
  type: 'neutral',
  range: 260,
  dps: 20.5,
  hit: 0.82,
  base: { dmg: 15.5, cd: 0.76, count: 1, pierce: 0 },
  arenaBasic: true,
};

function scaledStat(raw, center, exponent = 0.35) {
  return center * Math.pow(Math.max(0.01, raw / center), exponent);
}

function typeMultiplier(attackType, defenderTypes) {
  // The normal PvE chart is intentionally softened for PvP. A hard counter
  // should matter, but should not decide the fight before positioning does.
  if (attackType === 'neutral') return 1;
  const raw = G.Types.mult(attackType, defenderTypes);
  return Math.max(0.76, Math.min(1.34, Math.sqrt(raw)));
}

function moveAt(id, level) {
  return G.Moves.instance(id, Math.max(1, Math.min(5, level)));
}

function moveForAbility(ability, level) {
  return ability.arenaBasic ? {
    ...ability.base,
    dmg: ability.base.dmg * (1 + 0.16 * (Math.max(1, level) - 1)),
  } : moveAt(ability.id, level);
}

function moveRange(m) {
  const k = KIND[m.kind] || KIND.projectile;
  return typeof k.range === 'function' ? k.range(m) : k.range;
}

function moveDps(m) {
  const k = KIND[m.kind] || KIND.projectile;
  if (!m.dmg || m.kind === 'buff') return 0;
  const cd = Math.max(0.12, m.cd || 1);
  const status = 1 + (m.burn ? 0.06 : 0) + (m.poison ? 0.08 : 0) + (m.slow ? 0.05 : 0);
  return (m.dmg * k.hits(m) * k.hit * status) / cd;
}

function abilityFor(id, level) {
  const m = moveAt(id, level);
  const k = KIND[m.kind] || KIND.projectile;
  return {
    id,
    kind: m.kind,
    type: m.type,
    range: moveRange(m),
    dps: moveDps(m),
    hit: k.hit,
    base: m,
  };
}

function chooseMoves(mon) {
  const start = G.Moves.startFor(mon);
  const pool = G.Moves.poolFor(mon)
    .filter(id => id !== start && G.Moves.BY_ID[id] && G.Moves.BY_ID[id].kind !== 'buff')
    .map(id => ({ id, score: moveDps(G.Moves.BY_ID[id]) }))
    .sort((a, b) => b.score - a.score);
  // Keep the full compatible pool. Each simulated player receives a seeded
  // random subset, so the test covers different skill combinations instead
  // of always selecting the same paper-DPS loadout.
  return [start, ...pool.map(item => item.id)];
}

const ROLE_BASE = new Map(ROSTER.map(mon => [mon.dex, {
  dex: mon.dex,
  name: mon.name,
  types: mon.types,
  hp: scaledStat(mon.hp, MEDIAN.hp),
  spd: scaledStat(mon.spd, MEDIAN.spd),
  atk: scaledStat(mon.atk, MEDIAN.atk),
  raw: mon,
  moves: chooseMoves(mon),
  balance: 1
}]));

function configFromRoles() {
  const out = {};
  for (const role of ROLE_BASE.values()) out[role.dex] = role.balance;
  return out;
}

function zoneRadius(t) {
  if (t < 420) return 930;
  if (t < SAFE_SECONDS) return 930 - ((t - 420) / 180) * 510;
  return Math.max(18, 420 - ((t - SAFE_SECONDS) / FRENZY_SECONDS) * 402);
}

function makeAgent(role, slot, random, balance) {
  const angle = (slot / PLAYERS) * Math.PI * 2 + (random() - 0.5) * 0.12;
  const spawnRadius = 560;
  const skillPool = role.moves.slice(1).map(id => abilityFor(id, 1));
  for (let i = skillPool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [skillPool[i], skillPool[j]] = [skillPool[j], skillPool[i]];
  }
  const loadout = [role.moves[0], ...skillPool.slice(0, 3)];
  const move = [ARENA_BASIC, ...loadout.map(id => abilityFor(id, 1))];
  const hpMul = Math.pow(balance, 0.52);
  const dmgMul = Math.pow(balance, 0.76);
  return {
    role,
    x: Math.cos(angle) * spawnRadius,
    y: Math.sin(angle) * spawnRadius,
    maxHp: role.hp * hpMul,
    hp: role.hp * hpMul,
    spd: role.spd * (0.985 + 0.03 * random()),
    atk: role.atk * dmgMul,
    balance,
    abilities: move,
    cooldown: 0,
    alive: true,
    kills: 0,
    damage: 0,
    hitsLanded: 0,
    attackAttempts: 0,
    killHitCountTotal: 0,
    hitLedger: new Map(),
    skillUses: new Map(),
    survival: 0,
    level: 1,
    slow: 0,
    deathTime: null,
    lastHp: 0,
    lastDamageBy: -1,
    jitter: random() * Math.PI * 2,
    currentAbility: null,
  };
}

function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function chooseAbility(agent, distance, time, random) {
  const unlocked = Math.min(agent.abilities.length, 1 + Math.floor(time / 150));
  let best = agent.abilities[0];
  let bestScore = -1;
  const scored = [];
  for (let i = 0; i < unlocked; i++) {
    const a = agent.abilities[i];
    const rangeFit = distance <= a.range ? 1 : Math.max(0.12, a.range / distance);
    const closeRisk = a.kind === 'melee' || a.kind === 'aura' || a.kind === 'dash' ? (distance < 160 ? 1.12 : 0.72) : 1;
    const score = a.dps * rangeFit * closeRisk;
    scored.push({ ability: a, score });
    if (score > bestScore) { best = a; bestScore = score; }
  }
  if (scored.length > 1 && random() < RANDOM_SKILL_RATE) {
    const weighted = scored.reduce((sum, item) => sum + Math.pow(Math.max(0.01, item.score), 0.72), 0);
    let pick = random() * weighted;
    for (const item of scored) {
      pick -= Math.pow(Math.max(0.01, item.score), 0.72);
      if (pick <= 0) return item.ability;
    }
  }
  return best;
}

function killAgent(attacker, victim, now) {
  if (!victim.alive) return;
  victim.alive = false;
  victim.hp = 0;
  victim.deathTime = now;
  if (attacker && attacker !== victim) attacker.kills++;
}

function attackEvent(attacker, victim, ability, distance, random) {
  if (!attacker.alive || !victim.alive) return null;
  const rangeFit = distance <= ability.range ? 1 : Math.max(0.05, ability.range / distance);
  const kind = KIND[ability.kind] || KIND.projectile;
  const accuracy = Math.max(0.18, Math.min(1, kind.hit * (0.78 + rangeFit * 0.28)));
  if (random() > accuracy) return null;

  const level = attacker.level;
  const m = moveForAbility(ability, level);
  const typeK = typeMultiplier(ability.type, victim.role.types);
  const hits = kind.hits(m);
  const spread = 0.86 + random() * 0.28;
  const closeBonus = ability.kind === 'melee' && distance < ability.range ? 1.12 : 1;
  const closeDefense = victim.currentAbility &&
    ['melee', 'aura', 'dash'].includes(victim.currentAbility.kind) && distance < 150 ? 0.76 : 1;
  const damage = Math.max(1, m.dmg * hits * attacker.atk * typeK * spread * closeBonus * closeDefense * ARENA_DAMAGE_SCALE);
  return {
    damage,
    slow: m.slow ? 1.4 : 0,
    drain: m.drain ? m.drain * 0.6 : 0,
  };
}

function resolveMatch(roleConfig, seed) {
  const random = rng(seed);
  const agents = new Array(PLAYERS);
  for (let i = 0; i < PLAYERS; i++) {
    const role = ROLE_BASE.get(ROSTER[Math.floor(random() * ROSTER.length)].dex);
    agents[i] = makeAgent(role, i, random, roleConfig[role.dex] || 1);
  }

  for (let now = 0; now <= TOTAL_SECONDS && agents.some(a => a.alive); now += TICK) {
    const alive = agents.filter(a => a.alive);
    const radius = zoneRadius(now);
    const intents = [];

    for (const a of alive) {
      a.survival += TICK;
      a.cooldown -= TICK;
      if (a.slow > 0) a.slow -= TICK;
      const target = alive
        .filter(b => b !== a)
        .sort((x, y) => dist2(a, x) - dist2(a, y))[0];
      if (!target) continue;

      const d2 = dist2(a, target);
      const d = Math.sqrt(d2);
      const ability = chooseAbility(a, d, now, random);
      a.currentAbility = ability;
      const desired = Math.max(75, Math.min(320, ability.range * 0.72));
      let dx = target.x - a.x, dy = target.y - a.y;
      const inv = d > 0 ? 1 / d : 0;
      dx *= inv; dy *= inv;
      const ranged = ability.kind !== 'melee' && ability.kind !== 'aura' && ability.kind !== 'dash';
      if (ranged && d < desired * 0.65) { dx = -dx; dy = -dy; }
      else if (d < desired * 1.1) {
        const side = Math.sin(now * 0.8 + a.jitter) * 0.55;
        const tx = dx * (1 - Math.abs(side)) - dy * side;
        const ty = dy * (1 - Math.abs(side)) + dx * side;
        dx = tx; dy = ty;
      }
      const closeCombat = ability.kind === 'melee' || ability.kind === 'aura' || ability.kind === 'dash';
      // Ranged bots can kite indefinitely in a coarse model; give close
      // combat a deliberate engage-speed bonus to reflect the game's melee
      // damage-reduction rule and keep melee viable in PvP.
      const engageSpeed = closeCombat && d > desired ? 1.10 : 1;
      const speed = a.spd * engageSpeed * (a.slow > 0 ? 0.72 : 1);
      a.x += dx * speed * TICK;
      a.y += dy * speed * TICK;

      const outside = Math.hypot(a.x, a.y) > radius;
      if (a.cooldown <= 0 && d <= ability.range * 1.04) {
        const m = moveForAbility(ability, a.level);
        a.cooldown = Math.max(0.16, (m.cd || 1) * (1 - Math.min(0.22, Math.floor(now / 150) * 0.055)));
        a.attackAttempts++;
        a.skillUses.set(ability.id, (a.skillUses.get(ability.id) || 0) + 1);
        intents.push({ attacker: a, victim: target, ability, distance: d });
      }
    }

    // Resolve attacks simultaneously. The previous sequential resolution let
    // the first array slot kill later slots before they could act, which is an
    // implementation artefact rather than a PvP balance signal.
    const pending = new Map(agents.map(a => [a, { damage: 0, healing: 0, slow: 0, sources: [] }]));
    for (const intent of intents) {
      const event = attackEvent(intent.attacker, intent.victim, intent.ability, intent.distance, random);
      if (!event) continue;
      const targetState = pending.get(intent.victim);
      const attackerState = pending.get(intent.attacker);
      targetState.damage += event.damage;
      targetState.slow = Math.max(targetState.slow, event.slow);
      targetState.sources.push({ attacker: intent.attacker, damage: event.damage });
      attackerState.healing += event.drain;
      intent.attacker.damage += event.damage;
      intent.attacker.hitsLanded++;
      intent.attacker.hitLedger.set(intent.victim, (intent.attacker.hitLedger.get(intent.victim) || 0) + 1);
    }
    for (const a of alive) {
      const state = pending.get(a);
      if (state.damage > 0) {
        a.lastHp = a.hp;
        a.hp -= state.damage;
        a.lastDamageBy = state.sources.sort((x, y) => y.damage - x.damage)[0]?.attacker.role.dex ?? -1;
      }
      if (state.slow > 0) a.slow = Math.max(a.slow, state.slow);
      if (state.healing > 0) a.hp = Math.min(a.maxHp, a.hp + state.healing);
    }
    for (const a of alive) {
      if (a.hp <= 0) {
        const sources = pending.get(a).sources;
        const killer = sources.sort((x, y) => y.damage - x.damage)[0]?.attacker || null;
        if (killer) killer.killHitCountTotal += killer.hitLedger.get(a) || 0;
        killAgent(killer, a, now);
      }
    }

    // Gas is applied after the simultaneous combat exchange so two players
    // caught outside the zone can still trade their final attacks.
    for (const a of agents.filter(x => x.alive)) {
      if (Math.hypot(a.x, a.y) > radius) {
        const frenzy = now >= SAFE_SECONDS;
        const gas = a.maxHp * (frenzy ? 0.075 : 0.012) * TICK;
        a.hp -= gas;
        if (a.hp <= 0) killAgent(null, a, now);
      }
    }

    // Shared time-based skill growth isolates character balance from early-kill
    // snowballing. The later report also records whether this assumption matters.
    for (const a of agents) if (a.alive) a.level = Math.min(5, 1 + Math.floor(now / 150));
  }

  const survivors = agents.filter(a => a.alive);
  if (survivors.length === 1) return { winner: survivors[0], agents };
  if (survivors.length > 1) {
    survivors.sort((a, b) => b.hp - a.hp || b.kills - a.kills || b.damage - a.damage);
    return { winner: survivors[0], agents };
  }
  const dead = [...agents].sort((a, b) => (b.deathTime ?? -1) - (a.deathTime ?? -1)
    || b.kills - a.kills || b.damage - a.damage || b.lastHp - a.lastHp);
  return { winner: dead[0], agents };
}

function simulate(roleConfig, matches, seed) {
  const stats = new Map(ROSTER.map(m => [m.dex, {
    dex: m.dex, name: m.name, samples: 0, wins: 0, top3: 0,
    totalSurvival: 0, totalDamage: 0, totalKills: 0,
    totalHitsLanded: 0, totalAttackAttempts: 0, totalKillHitCount: 0,
    gasDeaths: 0
  }]));

  for (let i = 0; i < matches; i++) {
    const result = resolveMatch(roleConfig, seed + i * 0x9e3779b9);
    const ordered = [...result.agents].sort((a, b) => {
      if (a === result.winner) return -1;
      if (b === result.winner) return 1;
      return (b.deathTime ?? TOTAL_SECONDS + 1) - (a.deathTime ?? TOTAL_SECONDS + 1);
    });
    ordered.forEach((a, place) => {
      const s = stats.get(a.role.dex);
      s.samples++;
      if (a === result.winner) s.wins++;
      if (place < 3) s.top3++;
      s.totalSurvival += a.survival;
      s.totalDamage += a.damage;
      s.totalKills += a.kills;
      s.totalHitsLanded += a.hitsLanded;
      s.totalAttackAttempts += a.attackAttempts;
      s.totalKillHitCount += a.killHitCountTotal;
      if (a.deathTime != null && a.deathTime >= SAFE_SECONDS) s.gasDeaths++;
    });
  }
  for (const s of stats.values()) {
    s.winRate = s.wins / Math.max(1, s.samples);
    s.top3Rate = s.top3 / Math.max(1, s.samples);
    s.avgSurvival = s.totalSurvival / Math.max(1, s.samples);
    s.avgDamage = s.totalDamage / Math.max(1, s.samples);
    s.avgKills = s.totalKills / Math.max(1, s.samples);
    s.avgHitsLanded = s.totalHitsLanded / Math.max(1, s.samples);
    s.avgAttackAttempts = s.totalAttackAttempts / Math.max(1, s.samples);
    s.avgHitsToKill = s.totalKills > 0 ? s.totalKillHitCount / s.totalKills : null;
    s.gasDeathRate = s.gasDeaths / Math.max(1, s.samples);
    s.powerIndex = 0.62 * (s.winRate / TARGET_WIN_RATE) + 0.38 * (s.top3Rate / TARGET_TOP3_RATE);
  }
  return [...stats.values()];
}

function balanceSummary(results) {
  const eligible = results.filter(s => s.samples >= 100);
  const max = Math.max(...eligible.map(s => s.winRate));
  const min = Math.min(...eligible.map(s => s.winRate));
  const meanAbs = eligible.reduce((sum, s) => sum + Math.abs(s.winRate - TARGET_WIN_RATE), 0) / eligible.length;
  return {
    minWin: min,
    maxWin: max,
    spread: max - min,
    meanAbsWinError: meanAbs,
    pass: max - min <= 0.075 && meanAbs <= 0.018,
  };
}

function combineResults(first, second) {
  const secondByDex = new Map(second.map(s => [s.dex, s]));
  return first.map(a => {
    const b = secondByDex.get(a.dex);
    const s = {
      dex: a.dex,
      name: a.name,
      samples: a.samples + b.samples,
      wins: a.wins + b.wins,
      top3: a.top3 + b.top3,
      totalSurvival: a.totalSurvival + b.totalSurvival,
      totalDamage: a.totalDamage + b.totalDamage,
      totalKills: a.totalKills + b.totalKills,
      totalHitsLanded: a.totalHitsLanded + b.totalHitsLanded,
      totalAttackAttempts: a.totalAttackAttempts + b.totalAttackAttempts,
      totalKillHitCount: a.totalKillHitCount + b.totalKillHitCount,
      gasDeaths: a.gasDeaths + b.gasDeaths,
    };
    s.winRate = s.wins / Math.max(1, s.samples);
    s.top3Rate = s.top3 / Math.max(1, s.samples);
    s.avgSurvival = s.totalSurvival / Math.max(1, s.samples);
    s.avgDamage = s.totalDamage / Math.max(1, s.samples);
    s.avgKills = s.totalKills / Math.max(1, s.samples);
    s.avgHitsLanded = s.totalHitsLanded / Math.max(1, s.samples);
    s.avgAttackAttempts = s.totalAttackAttempts / Math.max(1, s.samples);
    s.avgHitsToKill = s.totalKills > 0 ? s.totalKillHitCount / s.totalKills : null;
    s.gasDeathRate = s.gasDeaths / Math.max(1, s.samples);
    s.powerIndex = 0.62 * (s.winRate / TARGET_WIN_RATE) + 0.38 * (s.top3Rate / TARGET_TOP3_RATE);
    return s;
  });
}

function tune(initial, matches, iterations) {
  let config = { ...initial };
  let latest = null;
  const history = [];
  for (let i = 0; i < iterations; i++) {
    latest = combineResults(
      simulate(config, matches, TUNING_SEEDS[0]),
      simulate(config, matches, TUNING_SEEDS[1]),
    );
    const summary = balanceSummary(latest);
    history.push({ iteration: i + 1, ...summary });
    if (summary.pass) break;

    for (const s of latest) {
      const p = Math.max(0.55, Math.min(1.7, s.powerIndex));
      // Use a damped correction so a noisy sample cannot swing a role wildly.
      const correction = Math.pow(1 / p, 0.24);
      config[s.dex] = Math.max(0.72, Math.min(1.35, config[s.dex] * correction));
    }
  }
  return { config, results: latest, history };
}

function pct(n) { return `${(n * 100).toFixed(2)}%`; }

function printReport(before, after, tuned) {
  const sortedBefore = [...before].sort((a, b) => b.winRate - a.winRate);
  const sortedAfter = [...after].sort((a, b) => b.winRate - a.winRate);
  const validation = simulate(tuned.config, MATCHES, VALIDATION_SEED);
  const sortedValidation = [...validation].sort((a, b) => b.winRate - a.winRate);
  const starterKinds = {};
  for (const role of ROLE_BASE.values()) {
    const kind = abilityFor(role.moves[0], 1).kind;
    starterKinds[kind] = (starterKinds[kind] || 0) + 1;
  }
  const validationHits = validation
    .filter(s => s.totalKills > 0)
    .map(s => ({
      dex: s.dex,
      name: s.name,
      avgHitsToKill: Number(s.avgHitsToKill.toFixed(2)),
      avgHitsLanded: Number(s.avgHitsLanded.toFixed(2)),
      avgAttackAttempts: Number(s.avgAttackAttempts.toFixed(2)),
      kills: s.totalKills,
    }))
    .sort((a, b) => a.avgHitsToKill - b.avgHitsToKill);
  const totalValidationKills = validation.reduce((sum, s) => sum + s.totalKills, 0);
  const totalValidationKillHits = validation.reduce((sum, s) => sum + s.totalKillHitCount, 0);
  const report = {
    model: {
      roster: ROSTER.length,
      players: PLAYERS,
      matchesPerPass: MATCHES,
      tickSeconds: TICK,
      safeSeconds: SAFE_SECONDS,
      frenzySeconds: FRENZY_SECONDS,
      growth: 'shared PvP level at 0/150/300/450/600 seconds; no monster XP or PvE data',
      duplicateRoles: 'allowed',
      typeChart: 'sqrt-softened and clamped to 0.76–1.34',
      openingRule: 'shared neutral arena-basic attack; role moves unlock at 150/300/450 seconds',
      skillSelection: 'each match: start skill plus 3 seeded-random skills from that role\'s own compatible pool; 35% weighted random choice among unlocked skills',
      damageScale: ARENA_DAMAGE_SCALE,
      targetHitsToKill: TARGET_HITS_TO_KILL,
      originalStarterKinds: starterKinds,
    },
    balanceCriteria: {
      targetWinRate: TARGET_WIN_RATE,
      targetTop3Rate: TARGET_TOP3_RATE,
      targetHitsToKill: TARGET_HITS_TO_KILL,
      stopRule: 'win-rate spread <= 7.5 percentage points and mean absolute error <= 1.8 points',
    },
    tuningHistory: tuned.history,
    validation: {
      matches: MATCHES,
      seed: VALIDATION_SEED,
      summary: balanceSummary(validation),
      strongest: sortedValidation.slice(0, 8).map(s => ({ name: s.name, dex: s.dex, win: pct(s.winRate), top3: pct(s.top3Rate), samples: s.samples })),
      weakest: sortedValidation.slice(-8).reverse().map(s => ({ name: s.name, dex: s.dex, win: pct(s.winRate), top3: pct(s.top3Rate), samples: s.samples })),
      overallHitsToKill: Number((totalValidationKillHits / Math.max(1, totalValidationKills)).toFixed(2)),
      hitsTargetPass: Math.abs((totalValidationKillHits / Math.max(1, totalValidationKills)) - TARGET_HITS_TO_KILL) <= 0.5,
      totalKills: totalValidationKills,
      totalKillHitCount: totalValidationKillHits,
      fastestHitsToKill: validationHits.slice(0, 8),
      slowestHitsToKill: validationHits.slice(-8).reverse(),
      byRole: validationHits,
    },
    strongestBefore: sortedBefore.slice(0, 8).map(s => ({ name: s.name, dex: s.dex, win: pct(s.winRate), top3: pct(s.top3Rate), samples: s.samples })),
    weakestBefore: sortedBefore.slice(-8).reverse().map(s => ({ name: s.name, dex: s.dex, win: pct(s.winRate), top3: pct(s.top3Rate), samples: s.samples })),
    strongestAfter: sortedAfter.slice(0, 8).map(s => ({ name: s.name, dex: s.dex, win: pct(s.winRate), top3: pct(s.top3Rate), samples: s.samples })),
    weakestAfter: sortedAfter.slice(-8).reverse().map(s => ({ name: s.name, dex: s.dex, win: pct(s.winRate), top3: pct(s.top3Rate), samples: s.samples })),
    arenaMultipliers: ROSTER.map(mon => ({ dex: mon.dex, name: mon.name, multiplier: Number(tuned.config[mon.dex].toFixed(4)) })),
  };
  const text = JSON.stringify(report, null, 2);
  const outputPath = args.get('out');
  if (outputPath) fs.writeFileSync(path.resolve(ROOT, outputPath), text + '\n', 'utf8');
  console.log(text);
}

const initial = configFromRoles();
const before = simulate(initial, MATCHES, BASE_SEED);
const tuned = tune(initial, MATCHES, ITERATIONS);
printReport(before, tuned.results, tuned);

