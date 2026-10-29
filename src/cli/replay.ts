/**
 * `npm run replay -- [--seed 7] [--full] [--open]`
 *
 * Runs ONE seed of the chaos simulation with a recorder attached and renders it as a self-contained,
 * interactive HTML timeline (replays/seed-<n>.html): every human edit, injected fault, lost or
 * duplicated webhook, crash, retry, sync decision and invariant check, with both systems' state at
 * any point in time. Same seed ⇒ same world, so a failing seed from CI can be watched, not just read.
 *
 *   default  a compact world (4 tasks, 3 rounds) that is easy to follow on screen
 *   --full   the exact configuration the test suite runs
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_POLICIES } from '../config.js';
import { Recorder } from '../testing/recorder.js';
import { runSimulation, SIM_CHAOS } from '../testing/simulation.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const seed = Number(arg('seed') ?? 7);
const full = process.argv.includes('--full');
const shape = full ? {} : { rounds: 3, opsPerRound: 14, initialTasks: 4, concurrentPerRound: 2 };

const recorder = new Recorder();
const t0 = performance.now();
const { violations, stats, harness } = await runSimulation({ seed, recorder, ...shape });
const ms = performance.now() - t0;

const data = {
  meta: {
    seed,
    full,
    shape: { rounds: 4, opsPerRound: 25, initialTasks: 5, concurrentPerRound: 3, ...shape },
    chaos: SIM_CHAOS,
    policies: DEFAULT_POLICIES,
    stats,
    violations,
    faults: { workfront: harness.wf.chaos.stats, jira: harness.jira.chaos.stats },
    generatedAt: new Date().toISOString(),
  },
  events: recorder.events,
};

const template = readFileSync(new URL('../replay/viewer.html', import.meta.url), 'utf8');
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const html = template.replace('"__REPLAY_DATA__"', () => json);
mkdirSync('replays', { recursive: true });
const out = `replays/seed-${seed}${full ? '-full' : ''}.html`;
writeFileSync(out, html);

console.log(`\nSeed ${seed}: ${recorder.events.length} events recorded in ${ms.toFixed(0)} ms — ${violations.length ? `\x1b[31m${violations.length} violation(s)\x1b[0m` : '\x1b[32mall invariants held\x1b[0m'}`);
console.log(`  ${stats.ops} human edits · ${stats.crashes} crashes · ${stats.conflictsResolved} conflicts resolved by a human`);
console.log(`  Workfront faults ${JSON.stringify(harness.wf.chaos.stats)}`);
console.log(`  Jira faults      ${JSON.stringify(harness.jira.chaos.stats)}`);
console.log(`\n  → ${out}  (${(html.length / 1024).toFixed(0)} KB, self-contained)\n`);
if (process.argv.includes('--open')) execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [out]);
