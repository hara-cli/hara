/** Offline, request-scoped benchmark accounting. A usage frame is cumulative, never a delta. */
export class BenchmarkUsageError extends Error {
  constructor(code) { super(code); this.name = 'BenchmarkUsageError'; this.code = code; }
}
const fail = code => { throw new BenchmarkUsageError(code); };
const count = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);

export function normalizeCumulativeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !count(value.prompt_tokens) || !count(value.completion_tokens)
    || !count(value.total_tokens) || value.total_tokens !== value.prompt_tokens + value.completion_tokens
    || !Number.isSafeInteger(value.prompt_tokens + value.completion_tokens)) fail('invalid_usage');
  return { inputTokens: value.prompt_tokens, outputTokens: value.completion_tokens, totalTokens: value.total_tokens };
}

/** Every request has its own accumulator. Increasing snapshots replace prior ones; equal snapshots
 * are diagnostic duplicates. Regressions are unknown accounting, not permission to choose a cheaper row. */
export function createCumulativeUsageRequest(requestId) {
  if (!id(requestId)) fail('invalid_request_id');
  let latest, frames = 0, duplicates = 0, finished = false, failure;
  const snapshot = () => ({ requestId, frames, duplicateFrames: duplicates,
    usage: latest ? { ...latest } : undefined, finished, ...(failure ? { failure } : {}) });
  return {
    observe(value) {
      if (finished) fail('request_already_settled');
      let next;
      try { next = normalizeCumulativeUsage(value); }
      catch (error) { failure = 'invalid_usage'; throw error; }
      frames++;
      if (latest && (next.inputTokens < latest.inputTokens || next.outputTokens < latest.outputTokens)) {
        failure = 'usage_regressed'; fail(failure);
      }
      if (latest && next.inputTokens === latest.inputTokens && next.outputTokens === latest.outputTokens) duplicates++;
      latest = next;
      return snapshot();
    },
    finish() {
      if (failure) fail(failure);
      if (!latest) fail('missing_usage');
      finished = true;
      return snapshot();
    },
    get snapshot() { return snapshot(); },
  };
}

/** No borrowing between independent trials. Admission reserves a caller-provided conservative upper
 * bound; complete requests release unused reservation. Unknown accounting conservatively charges the
 * reservation and halts every later request. Counts remain truthful even if an upstream violates it. */
export function createBenchmarkUsageLedger({ maxTotalIO = 80000, now = () => performance.now() } = {}) {
  if (!count(maxTotalIO) || maxTotalIO < 1 || typeof now !== 'function') fail('invalid_budget');
  const trials = new Map(), requests = new Map();
  let committedIO = 0, allocatedIO = 0, haltReason;
  const pendingIO = () => [...requests.values()].filter(request => !request.settled).reduce((sum, request) => sum + request.reservedIO, 0);
  const trialPendingIO = trialId => [...requests.values()].filter(request => !request.settled && request.trialId === trialId).reduce((sum, request) => sum + request.reservedIO, 0);
  const requestSnapshot = request => ({ requestId: request.requestId, trialId: request.trialId, reservedIO: request.reservedIO,
    settled: request.settled, ...(request.outcome ? { outcome: request.outcome } : {}), chargedIO: request.chargedIO,
    ...request.accumulator.snapshot });
  const snapshot = () => ({ maxTotalIO, committedIO, pendingIO: pendingIO(), haltReason,
    actualKnownIO: [...requests.values()].reduce((sum, request) => sum + (request.accumulator.snapshot.usage?.totalTokens ?? 0), 0),
    trials: [...trials.values()].map(trial => ({ trialId: trial.trialId, maxIO: trial.maxIO, committedIO: trial.committedIO,
      requests: trial.requests, maxRequests: trial.maxRequests, pendingIO: trialPendingIO(trial.trialId), timeoutMs: trial.timeoutMs })),
    requests: [...requests.values()].map(requestSnapshot) });
  return {
    startTrial(trialId, { maxIO, maxRequests = 12, timeoutMs = 150000 } = {}) {
      if (!id(trialId) || trials.has(trialId)) fail('invalid_trial_id');
      if (![maxIO, maxRequests, timeoutMs].every(value => count(value) && value > 0)
        || allocatedIO + maxIO > maxTotalIO) fail('invalid_trial_budget');
      allocatedIO += maxIO;
      trials.set(trialId, { trialId, maxIO, maxRequests, timeoutMs, startedAt: now(), requests: 0, committedIO: 0 });
    },
    beginRequest(requestId, trialId, { reservedIO } = {}) {
      if (haltReason) fail('accounting_halted');
      if (!id(requestId) || requests.has(requestId)) fail('invalid_request_id');
      const trial = trials.get(trialId); if (!trial) fail('unknown_trial');
      if (!count(reservedIO) || reservedIO < 1) fail('invalid_reservation');
      if (now() - trial.startedAt >= trial.timeoutMs) fail('deadline_reached');
      if (trial.requests >= trial.maxRequests) fail('request_limit_reached');
      if (trial.committedIO + trialPendingIO(trialId) + reservedIO > trial.maxIO) fail('trial_budget_rejected');
      if (committedIO + pendingIO() + reservedIO > maxTotalIO) fail('global_budget_rejected');
      const request = { requestId, trialId, reservedIO, accumulator: createCumulativeUsageRequest(requestId), settled: false, chargedIO: 0 };
      trial.requests++; requests.set(requestId, request); return requestSnapshot(request);
    },
    observeUsage(requestId, value) {
      const request = requests.get(requestId); if (!request || request.settled) fail('unknown_or_settled_request');
      try { return request.accumulator.observe(value); }
      catch (error) { haltReason = error.code ?? 'invalid_usage'; throw error; }
    },
    settleRequest(requestId, { complete = true } = {}) {
      const request = requests.get(requestId); if (!request) fail('unknown_request');
      if (request.settled) return requestSnapshot(request); // Idempotent settlement, never a second charge.
      let actual, reason;
      try { actual = request.accumulator.finish().usage; }
      catch (error) { reason = error.code ?? 'invalid_usage'; }
      if (!complete) reason ??= 'incomplete_usage';
      if (actual && actual.totalTokens > request.reservedIO) reason = 'reservation_exceeded';
      request.chargedIO = reason ? Math.max(request.reservedIO, actual?.totalTokens ?? 0,
        request.accumulator.snapshot.usage?.totalTokens ?? 0) : actual.totalTokens;
      request.settled = true; request.outcome = reason ?? 'complete';
      committedIO += request.chargedIO; trials.get(request.trialId).committedIO += request.chargedIO;
      if (reason) haltReason = reason;
      return requestSnapshot(request);
    },
    get snapshot() { return snapshot(); },
  };
}

/** UTF-8 input bytes are a conservative reservation, not measured prompt tokens. */
export function benchmarkRequestReservation(serializedBody, maxOutputTokens = 4096) {
  if (typeof serializedBody !== 'string' || !count(maxOutputTokens) || maxOutputTokens < 1) fail('invalid_reservation');
  const inputBytes = Buffer.byteLength(serializedBody, 'utf8');
  if (inputBytes > 1024 * 1024) fail('request_too_large');
  return { inputBytes, outputHeadroom: maxOutputTokens, reservedIO: inputBytes + maxOutputTokens };
}
