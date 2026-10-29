import { describe, expect, it } from 'vitest';
import { runSimulation } from '../src/testing/simulation.js';

/**
 * The chaos simulation (see src/testing/simulation.ts for the world and the invariants).
 * Every failure names its seed; `SIM_SEED=<n> npm test` replays it exactly, and
 * `npm run replay -- --seed <n>` renders it as an interactive timeline.
 */
const SEEDS = process.env.SIM_SEED
  ? [Number(process.env.SIM_SEED)]
  : Array.from({ length: Number(process.env.SIM_SEEDS ?? 25) }, (_, i) => i + 1);

describe.each(SEEDS)('chaos simulation, seed %i', (seed) => {
  it('converges with no lost updates, no duplicates and no stuck work', async () => {
    const { violations, stats, harness: h } = await runSimulation({
      seed,
      onLostUpdate: process.env.SIM_DEBUG
        ? (k, v, h) => console.log(k, 'expected', v, JSON.stringify(h.store.auditFor(k.split('/')[0], 30).reverse()))
        : undefined,
    });
    if (process.env.SIM_VERBOSE) {
      console.log(JSON.stringify({ seed, ...stats, wfChaos: h.wf.chaos.stats, jiraChaos: h.jira.chaos.stats }));
    }
    expect(violations).toEqual([]);
  }, 60_000);
});
