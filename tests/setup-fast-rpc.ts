// Global test setup: make the Pearl RPC transport fast and deterministic.
//
// Production pacing (3 req/s token bucket, 0.5–8 s backoff) would make
// every mocked-fetch test wait real seconds. Tests that exercise the
// pacing/backoff themselves (tests/v07-rpc-transport.test.ts) restore the
// production tuning explicitly and drive time with fake timers.
import { beforeEach } from "vitest";
import {
  _setPearlRpcTuningForTests,
  _resetPearlRpcHealthForTests,
  _clearAddressHistoryForTests,
} from "../src/services/pearl-rpc";

export const FAST_RPC_TUNING = {
  ratePerSec: Infinity,
  burst: 1_000,
  backoffBaseMs: 1,
  backoffMaxMs: 4,
  maxRetries: 5,
  retryBudgetMs: 5_000,
} as const;

beforeEach(() => {
  _setPearlRpcTuningForTests(undefined);
  _setPearlRpcTuningForTests(FAST_RPC_TUNING);
  _resetPearlRpcHealthForTests();
  _clearAddressHistoryForTests();
});
