import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const checks = [];
const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

const files = [
  'cloudflare/data-worker.js',
  'js/systems/arena.js',
  'js/net/arena-online.js',
  'js/ui/arena-mvp.js',
  'js/ui/arena-feedback.js'
];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  check(`syntax:${file}`, result.status === 0, (result.stderr || '').trim());
}

const balance = read('tools/arena-balance-report-random-100k.json');
const anomaly = read('tools/arena-damage-anomaly-report-10k.json');
check('balance.roster', balance.model?.roster === 103, `roster=${balance.model?.roster}`);
check('balance.large-sample', balance.model?.matchesPerPass >= 100000, `matches=${balance.model?.matchesPerPass}`);
check('balance.validation', balance.validation?.summary?.pass === true, JSON.stringify(balance.validation || {}));
check('balance.hits-target', balance.validation?.hitsTargetPass === true, JSON.stringify(balance.validation || {}));
check('anomaly.no-occluded-damage', anomaly.counters?.occludedDamageAccepted === 0,
  `accepted=${anomaly.counters?.occludedDamageAccepted}`);
check('anomaly.wall-blocked-rejected', anomaly.checks?.wallBlockedDamageWasAccepted === 0,
  JSON.stringify(anomaly.checks || {}));
check('anomaly.no-classic-event-route', anomaly.checks?.noArenaBossOrClassicEventRoute === true,
  JSON.stringify(anomaly.checks || {}));

const schema = fs.readFileSync(path.join(root, 'cloudflare/data-schema.sql'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'cloudflare/data-worker.js'), 'utf8');
for (const token of [
  'arena_match_telemetry', 'arena_match_incidents', 'mode_version',
  'server_state_updates', 'outcome_rank', 'arena_reward_claims',
  'balanceVersion: \'sim-100k-v3\''
]) check(`storage:${token}`, schema.includes(token) || worker.includes(token));
check('worker-no-old-arena-version', !worker.includes('arena-mvp-online-v1'));
check('share-campaigns-preserve-old-and-add-arena',
  worker.includes('share_t1_5_v1') && worker.includes('arena_share_t1_3_v1'),
  'existing general campaign and new Arena campaign must both remain valid');
check('first-match-reward-server-gated',
  worker.includes('arena_first_match_t1_v1') && worker.includes('grantArenaFirstMatchReward'),
  'first-match ticket must be granted from the online outcome path');

const failed = checks.filter(item => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  checkedAt: new Date().toISOString(),
  deploymentPerformed: false,
  checks,
  failed: failed.length
}, null, 2));
process.exitCode = failed.length ? 1 : 0;
