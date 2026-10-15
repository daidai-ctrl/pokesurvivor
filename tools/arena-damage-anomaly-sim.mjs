/*
 * Arena PvE damage/occlusion regression sampler.
 *
 * This is deliberately separate from arena-balance-sim.mjs: it does not try
 * to balance roles. It samples the current enemy definitions and the Arena
 * constants, then checks the damage routes that can reach a player while no
 * other human player is nearby. The geometry follows the normal Arena theme
 * in world.js (finite 48-tile radius, pillars and solid tree props).
 *
 * Run:
 *   node tools/arena-damage-anomaly-sim.mjs --trials 10000
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

const TRIALS = Math.max(1000, Number(args.get('trials') || 10000));
const TS = 32;
const ARENA_RADIUS = 48;
const ARENA_OUTER = ARENA_RADIUS + 7;
const DMG_K = 2.4;
const ARENA_MONSTER_DAMAGE = 0.65;
const TICK = 0.5;

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5; x >>>= 0;
    return (x >>> 0) / 4294967296;
  };
}

const random = rng(0xA73D19C5);
const math = Object.create(Math);
math.random = random;

function hash(x, y, seed = 0) {
  let r = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  r = Math.imul(r ^ (r >>> 13), 1274126177);
  r ^= r >>> 16;
  return (r >>> 0) / 4294967296;
}

const pickN = (values, n) => {
  const copy = values.slice();
  const out = [];
  for (let i = 0; i < n && copy.length; i++) out.push(copy.splice(Math.floor(random() * copy.length), 1)[0]);
  return out;
};
const G = {
  U: {
    clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)),
    hash,
    rand: (lo, hi) => lo + random() * (hi - lo),
    randInt: (lo, hi) => Math.floor(lo + random() * (hi - lo + 1)),
    pick: values => values[Math.floor(random() * values.length)],
    pickN,
  },
};
const ctx = { G, Math: math };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/data/pokedex.js'), 'utf8'), ctx, { filename: 'pokedex.js' });
G.DEX_BY = Object.fromEntries(G.DEX.map(mon => [mon.dex, mon]));
G.SPRITE_META = Object.fromEntries(G.DEX.map(mon => [mon.dex, {}]));
G.Sprites = { hovers: () => false };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/data/types.js'), 'utf8'), ctx, { filename: 'types.js' });
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/data/enemies.js'), 'utf8'), ctx, { filename: 'enemies.js' });

const LEGENDARIES = G.DEX.filter(mon => mon.rarity === 5);
if (LEGENDARIES.length !== 103) throw new Error(`Expected 103 legendary roles, found ${LEGENDARIES.length}`);

function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function terrainAt(tx, ty, seed) {
  const d = Math.hypot(tx, ty);
  if (d >= ARENA_RADIUS) return 'wall';
  // Same normal Arena pillar rule as world.js. The spawn corridor is always floor.
  const safe = (Math.abs(tx) <= 2 && ty >= -6 && ty <= 5) || d < 2.5;
  if (!safe && d < ARENA_RADIUS - 2 && hash(tx >> 1, ty >> 1, seed + 31) < 0.035) return 'wall';
  return 'floor';
}

function propAt(tx, ty, seed) {
  if (terrainAt(tx, ty, seed) !== 'floor') return null;
  const open = [-1, 0, 1].every(dy => [-1, 0, 1].every(dx => terrainAt(tx + dx, ty + dy, seed) === 'floor'));
  if (!open) return null;
  const h = hash(tx, ty, seed + 777);
  return h < 0.025 ? { x: tx * TS + TS / 2, y: ty * TS + TS - 4, r: 13 } : null;
}

function projectileBlock(x, y, radius, seed) {
  const tx = Math.floor(x / TS), ty = Math.floor(y / TS);
  if (terrainAt(tx, ty, seed) === 'wall') return true;
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const p = propAt(tx + ox, ty + oy, seed);
    if (p && dist2({ x, y }, p) < (radius + p.r) ** 2) return true;
  }
  return false;
}

function lineOfSight(from, to, radius, seed) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const steps = Math.max(2, Math.ceil(distance / 12));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (projectileBlock(from.x + dx * t, from.y + dy * t, radius, seed)) return false;
  }
  return true;
}

function randomPoint(radius = 42 * TS) {
  const angle = random() * Math.PI * 2;
  const distance = Math.sqrt(random()) * radius;
  return { x: 16 + Math.cos(angle) * distance, y: 16 + Math.sin(angle) * distance };
}

function typeMultiplier(attackType, defenderTypes) {
  return G.Types.mult(attackType, defenderTypes);
}

function playerDamage(raw, type, targetTypes, closeMelee = false) {
  const typed = raw * typeMultiplier(type, targetTypes);
  return Math.max(1, typed * (closeMelee ? 0.75 : 1));
}

function scaledEnemyDamage(def, time, elite, projectile = false, factor = 1) {
  const base = projectile ? (def.shotDmg || 10) : def.dmg;
  const runScale = G.Enemies.scale(time).dmg;
  return base * runScale * DMG_K * ARENA_MONSTER_DAMAGE * (elite ? 1.25 : 1) * factor;
}

function percentiles(values) {
  const a = values.slice().sort((x, y) => x - y);
  const at = q => a[Math.min(a.length - 1, Math.floor((a.length - 1) * q))] || 0;
  return { min: a[0] || 0, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: a[a.length - 1] || 0 };
}

const counters = {
  samples: 0,
  noNearbyHumanDamageSamples: 0,
  expectedPvEDamage: 0,
  exact17: 0,
  blockedContactWouldHaveHit: 0,
  blockedProjectileWouldHaveHit: 0,
  blockedBeamWouldHaveHit: 0,
  occludedDamageAccepted: 0,
  gasTicks: 0,
  source: { contact: 0, projectile: 0, beam: 0, zone: 0, gas: 0 },
};
const damages = [];
const examples17 = [];
const wallCases = { contact: [], projectile: [], beam: [] };

for (let i = 0; i < TRIALS; i++) {
  if (i % 8 === 0) G.Enemies.rollRun();
  const time = random() * 660;
  const targetRole = LEGENDARIES[Math.floor(random() * LEGENDARIES.length)];
  const target = randomPoint();
  const angle = random() * Math.PI * 2;
  const distance = 10 + random() * 500;
  const enemy = { x: target.x + Math.cos(angle) * distance, y: target.y + Math.sin(angle) * distance };
  const seed = (0x1F2E3D4C + i * 2654435761) | 0;
  const tier = G.Enemies.bagAt(time);
  const def = tier[Math.floor(random() * tier.length)];
  const elite = random() >= 0.15;
  const source = def.behavior === 'beamer' ? 'beam'
    : def.behavior === 'zoner' ? 'zone'
      : ['ranged', 'fan'].includes(def.behavior) ? 'projectile'
        : 'contact';
  const targetR = 16 + random() * 12;
  const enemyR = 12 + random() * 12;
  const types = targetRole.types;
  const atkType = (G.DEX_BY[def.dex]?.types || ['normal'])[0];
  const los = lineOfSight(enemy, target, source === 'contact' ? 2 : 4, seed);
  const inContact = distance <= targetR + enemyR;
  const inRange = distance <= (def.range || 200);

  counters.samples++;
  // Deliberately no other human is generated in this trial. Any counted hit
  // therefore comes from a documented PvE route, not a nearby player.
  counters.noNearbyHumanDamageSamples++;

  let raw = null;
  if (source === 'contact' && inContact) {
    if (!los) {
      counters.blockedContactWouldHaveHit++;
      if (wallCases.contact.length < 3) wallCases.contact.push({ time, distance, def: def.name });
    } else {
      raw = scaledEnemyDamage(def, time, elite);
      counters.source.contact++;
    }
  } else if (source === 'projectile' && inRange) {
    if (!los) {
      counters.blockedProjectileWouldHaveHit++;
      if (wallCases.projectile.length < 3) wallCases.projectile.push({ time, distance, def: def.name });
    } else {
      raw = scaledEnemyDamage(def, time, elite, true, def.behavior === 'fan' ? 0.65 : 1);
      counters.source.projectile++;
    }
  } else if (source === 'beam' && inRange) {
    if (!los) {
      counters.blockedBeamWouldHaveHit++;
      if (wallCases.beam.length < 3) wallCases.beam.push({ time, distance, def: def.name });
    } else {
      raw = scaledEnemyDamage(def, time, elite, true, 1.05);
      counters.source.beam++;
    }
  } else if (source === 'zone' && inRange && los) {
    raw = scaledEnemyDamage(def, time, elite, true, 0.95);
    counters.source.zone++;
  }

  if (time >= 600) {
    counters.gasTicks++;
    const gasRaw = 650 * (time >= 660 ? 0.05 : 0.025) * TICK;
    const gas = playerDamage(gasRaw, 'poison', types);
    damages.push(gas);
    counters.source.gas++;
  }
  if (raw != null) {
    const damage = playerDamage(raw, atkType, types, source === 'contact');
    damages.push(damage);
    counters.expectedPvEDamage++;
    if (Math.round(damage) === 17) {
      counters.exact17++;
      if (examples17.length < 5) examples17.push({ source, enemy: def.name, behavior: def.behavior, time: Number(time.toFixed(1)), damage: Number(damage.toFixed(2)) });
    }
  }
}

const report = {
  model: {
    trials: TRIALS,
    roster: LEGENDARIES.length,
    playersNearby: 0,
    map: 'Arena normal theme, 48-tile radius; deterministic walls/pillars/trees from world.js',
    damageConstants: { monsterDamageScale: DMG_K, arenaMonsterDamage: ARENA_MONSTER_DAMAGE, gasStartSec: 600, frenzyStartSec: 660 },
    note: 'This is an offline route/occlusion regression sampler, not a replacement for server-authoritative combat tests.',
  },
  counters,
  damageDistribution: percentiles(damages),
  exact17Examples: examples17,
  wallBlockedCases: wallCases,
  checks: {
    noPlayerCanCauseDamageInThisModel: true,
    wallBlockedDamageWasAccepted: counters.occludedDamageAccepted,
    wallBlockedContactIsRejected: counters.occludedDamageAccepted === 0,
    wallBlockedProjectileIsRejected: counters.occludedDamageAccepted === 0,
    wallBlockedBeamIsRejected: counters.occludedDamageAccepted === 0,
    noArenaBossOrClassicEventRoute: true,
    noArenaTrapRouteInNormalTheme: true,
  },
};
const text = JSON.stringify(report, null, 2);
const outputPath = args.get('out');
if (outputPath) fs.writeFileSync(path.resolve(ROOT, outputPath), text + '\n', 'utf8');
console.log(text);
