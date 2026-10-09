import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkRequestReservation, createBenchmarkUsageLedger, createCumulativeUsageRequest, normalizeCumulativeUsage } from '../scripts/benchmark-usage.mjs';
const usage = (input, output) => ({ prompt_tokens: input, completion_tokens: output, total_tokens: input + output });

test('one request counts one final cumulative snapshot, not every SSE frame or half a route total', () => {
  for (const frames of [[usage(7, 3)], [usage(7, 3), usage(7, 3)], [usage(7, 1), usage(7, 2), usage(7, 3), usage(7, 3)]]) {
    const request = createCumulativeUsageRequest('request-one'); frames.forEach(frame => request.observe(frame));
    assert.deepEqual(request.finish().usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    assert.equal(request.finish().usage.totalTokens, 10);
    assert.throws(() => request.observe(usage(7, 3)), /already_settled/);
  }
});
test('distinct requests with identical cumulative usage are separate operations', () => {
  const ledger = createBenchmarkUsageLedger({ maxTotalIO: 100 }); ledger.startTrial('trial', { maxIO: 100 });
  for (const name of ['first', 'second']) { ledger.beginRequest(name, 'trial', { reservedIO: 20 }); ledger.observeUsage(name, usage(7, 3)); ledger.observeUsage(name, usage(7, 3)); ledger.settleRequest(name); }
  assert.equal(ledger.snapshot.actualKnownIO, 20); assert.equal(ledger.snapshot.committedIO, 20);
  ledger.settleRequest('first'); assert.equal(ledger.snapshot.committedIO, 20);
});
test('strict usage rejects coercion, unsafe integers, mismatched totals and counter regressions', () => {
  for (const value of [null, {}, [], usage(-1, 1), usage(0.5, 1), usage(Number.MAX_SAFE_INTEGER, 1),
    { ...usage(1, 2), prompt_tokens: '1' }, { ...usage(1, 2), total_tokens: 4 }]) assert.throws(() => normalizeCumulativeUsage(value), /invalid_usage/);
  const request = createCumulativeUsageRequest('r'); request.observe(usage(4, 3));
  assert.throws(() => request.observe(usage(4, 2)), /usage_regressed/); assert.throws(() => request.finish(), /usage_regressed/);
});
test('independent trial budgets cannot borrow unused peer allowance', () => {
  const ledger = createBenchmarkUsageLedger({ maxTotalIO: 80 }); ledger.startTrial('pi', { maxIO: 40 }); ledger.startTrial('opencode', { maxIO: 40 });
  ledger.beginRequest('pi-first', 'pi', { reservedIO: 35 }); ledger.observeUsage('pi-first', usage(20, 10)); ledger.settleRequest('pi-first');
  assert.throws(() => ledger.beginRequest('pi-next', 'pi', { reservedIO: 11 }), /trial_budget_rejected/);
  ledger.beginRequest('oc-first', 'opencode', { reservedIO: 40 }); ledger.observeUsage('oc-first', usage(10, 5)); ledger.settleRequest('oc-first');
  assert.equal(ledger.snapshot.committedIO, 45); assert.equal(ledger.snapshot.trials[0].committedIO, 30);
});
test('pending conservative reservations block concurrent over-admission and release unused headroom', () => {
  const ledger = createBenchmarkUsageLedger({ maxTotalIO: 20 }); ledger.startTrial('trial', { maxIO: 20 });
  ledger.beginRequest('a', 'trial', { reservedIO: 15 }); assert.throws(() => ledger.beginRequest('b', 'trial', { reservedIO: 6 }), /budget_rejected/);
  ledger.observeUsage('a', usage(3, 2)); ledger.settleRequest('a'); ledger.beginRequest('b', 'trial', { reservedIO: 15 });
  assert.equal(ledger.snapshot.pendingIO, 15); assert.equal(ledger.snapshot.committedIO, 5);
});
test('missing/incomplete/invalid usage preserves potential spend and halts every later request', () => {
  for (const mode of ['missing', 'incomplete', 'invalid']) {
    const ledger = createBenchmarkUsageLedger({ maxTotalIO: 100 }); ledger.startTrial('trial', { maxIO: 100 });
    ledger.beginRequest('a', 'trial', { reservedIO: 30 });
    if (mode !== 'missing') ledger.observeUsage('a', usage(4, 2));
    if (mode === 'invalid') assert.throws(() => ledger.observeUsage('a', usage(3, 2)), /usage_regressed/);
    const settled = ledger.settleRequest('a', { complete: mode !== 'incomplete' });
    assert.equal(settled.chargedIO, 30); assert.equal(ledger.snapshot.committedIO, 30);
    assert.ok(ledger.snapshot.haltReason); assert.throws(() => ledger.beginRequest('b', 'trial', { reservedIO: 1 }), /accounting_halted/);
  }
});
test('an upstream reservation violation retains truthful overrun and refuses future work', () => {
  const ledger = createBenchmarkUsageLedger({ maxTotalIO: 10 }); ledger.startTrial('trial', { maxIO: 10 });
  ledger.beginRequest('a', 'trial', { reservedIO: 10 }); ledger.observeUsage('a', usage(8, 4));
  assert.equal(ledger.settleRequest('a').outcome, 'reservation_exceeded'); assert.equal(ledger.snapshot.committedIO, 12);
  assert.throws(() => ledger.beginRequest('b', 'trial', { reservedIO: 1 }), /accounting_halted/);
});
test('ledger stages share request count/deadline while distinct task trials remain independent', () => {
  let tick = 0; const ledger = createBenchmarkUsageLedger({ maxTotalIO: 100, now: () => tick });
  ledger.startTrial('ledger-pi', { maxIO: 50, maxRequests: 1, timeoutMs: 150 }); ledger.startTrial('range-oc', { maxIO: 50 });
  ledger.beginRequest('first', 'ledger-pi', { reservedIO: 10 }); ledger.observeUsage('first', usage(1, 1)); ledger.settleRequest('first');
  assert.throws(() => ledger.beginRequest('continuation', 'ledger-pi', { reservedIO: 1 }), /request_limit_reached/);
  tick = 150; assert.throws(() => ledger.beginRequest('late', 'ledger-pi', { reservedIO: 1 }), /deadline_reached/);
  ledger.beginRequest('independent', 'range-oc', { reservedIO: 10 });
});
test('UTF8 reservations account for non-ASCII bytes plus fixed output headroom', () => {
  assert.deepEqual(benchmarkRequestReservation('你', 4096), { inputBytes: 3, outputHeadroom: 4096, reservedIO: 4099 });
  assert.throws(() => benchmarkRequestReservation('x'.repeat(1024 * 1024 + 1)), /request_too_large/);
});
