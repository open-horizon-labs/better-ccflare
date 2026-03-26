# Session: anthropic-round-robin

## Aim
**Updated:** 2026-03-25

## Aim Statement

**Aim:** Clients can sustain Anthropic traffic longer before any single account exits its rolling limit window because requests are distributed in bounded bursts instead of pinning one account until it trips the window.

**Current State:** Session-based selection can over-concentrate Anthropic traffic on one account, causing that account to hit its rolling window early while sibling accounts still have headroom.
**Desired State:** Anthropic traffic consumes headroom across equivalent healthy accounts in controlled bursts, so total provider capacity stays usable for longer and session-limit events happen later and less often.

### Mechanism
**Change:** Add a burst-sticky Anthropic balancing mode that keeps an account for a small bounded number of requests or short dwell interval, then rotates to the next healthy same-provider account; preserve health checks, rate-limit avoidance, and failover.
**Hypothesis:** Pure per-request round robin is not the real goal. The goal is to avoid overfilling one rolling window. Rotating in bursts should spread window consumption across accounts while avoiding pathological per-request churn that can hurt cache locality and make account usage look unnaturally fragmented.
**Assumptions:**
- The dominant failure mode is one account exhausting its rolling session/window budget before the pool as a whole is saturated.
- Anthropic accounts in this pool are interchangeable for the target traffic; strict long-lived stickiness is not required for correctness.
- A burst-sticky policy retains enough locality to avoid the downsides the docs associate with non-session strategies, but this is still an operational hypothesis that needs validation.

### Feedback
**Signal:** During load tests, per-account rolling-window usage stays flatter, the first account hits its limit later, and aggregate successful Anthropic request volume before first exhaustion increases.
**Timeframe:** Immediate in controlled load testing; 1-2 production usage windows to confirm real traffic behaves the same way.

### Guardrails
- Do not rotate onto unhealthy, paused, recently rate-limited, or degraded Anthropic accounts just to satisfy fairness.
- Do not use per-request churn as a goal; if burst size collapses to one request, revisit because you are functionally back to true round robin.
- Do not regress workloads that depend on prompt-cache locality or conversational affinity without explicitly deciding that higher window longevity is worth that tradeoff.
- Revisit immediately if burst rotation increases bans, anomaly signals, or cache-efficiency regressions.


## Solution Space
**Updated:** 2026-03-25

## Solution Space Analysis

**Problem:** Anthropic traffic is exhausting individual rolling windows too early, causing frequent limit hits and poor cost efficiency.  
**Key Constraint:** You only have partially observable per-account headroom in real time, and wrong routing decisions can degrade reliability faster than they save money.

### Candidates Considered

| Option | Level | Approach | Trade-off |
|--------|-------|----------|-----------|
| A | Band-Aid | Keep current ccflare strategy, just buy a different account mix or more capacity | Pays around the scheduler; may preserve waste |
| B | Local Optimum | Add burst-sticky / weighted round-robin inside better-ccflare | Better distribution, but still heuristic and blind to true headroom |
| C | Reframe | Build a headroom-aware Anthropic scheduler inside better-ccflare using observed limit metadata, leases, reserve accounts, and request-cost classes | More logic and instrumentation to design and maintain |
| D | Redesign | Build a bespoke Anthropic-only router/service optimized around account state and rolling windows | Highest control, highest implementation and ownership cost |
| E | Reframe | Attack demand instead of routing: prompt/session hygiene, usage shaping, extra usage caps, and selective model/account mix changes | Requires behavior/process changes; may not fix hotspotting alone |

### Evaluation

**Option A: Buy Around the Problem**
- Solves stated problem: **Partially**
- Implementation cost: **Low**
- Maintenance burden: **Low**
- Second-order effects: You may spend materially more while keeping the same hotspotting behavior. If the scheduler is the real bug, more Max/Pro accounts only delays the pain.

**Option B: Burst-Sticky Heuristic in better-ccflare**
- Solves stated problem: **Partially**
- Implementation cost: **Medium**
- Maintenance burden: **Medium**
- Second-order effects: Better than current session bias, but still a local maximum. You may flatten usage somewhat without actually optimizing for time-to-first-exhaustion or cost per successful request.

**Option C: Headroom-Aware Anthropic Strategy in better-ccflare**
- Solves stated problem: **Yes**
- Implementation cost: **Medium-High**
- Maintenance burden: **Medium**
- Second-order effects: This is the best fit for the actual problem. The repo already captures Anthropic rate metadata in `packages/providers/src/providers/anthropic/provider.ts:243` and persists it in `packages/proxy/src/handlers/response-processor.ts:74`, but current routing in `packages/load-balancer/src/strategies/index.ts:141` is still session/priority driven. This option exploits existing plumbing without paying full rewrite cost.

**Option D: Bespoke Anthropic-Only Router**
- Solves stated problem: **Yes**
- Implementation cost: **High**
- Maintenance burden: **High**
- Second-order effects: Maximum control, but you now own proxy semantics, streaming correctness, auth/session refresh, persistence, failover, and observability. This only wins if better-ccflare’s abstractions actively block the needed policy.

**Option E: Demand/Workload Shaping**
- Solves stated problem: **Partially**
- Implementation cost: **Low-Medium**
- Maintenance burden: **Medium**
- Second-order effects: Can improve cost per successful request substantially because Anthropic usage is shape-dependent, but it does not by itself fix bad intra-pool routing. Best as a companion, not the primary solution.

### Recommendation

**Selected:** Option C - Headroom-Aware Anthropic Strategy in better-ccflare  
**Level:** **Reframe**

**Rationale:**  
The first workable idea was "add round robin." That is too low-level. The real problem is scheduling under rolling-window scarcity with incomplete state. Option C addresses that directly while reusing the hard parts the repo already gets right.

Why this one:
- It targets the actual objective: **more successful Anthropic work per euro**, not prettier balancing behavior.
- It uses existing repo capabilities instead of rebuilding them.
- It preserves the ability to compare account mixes later using better data rather than intuition.
- It leaves the bespoke-router path open if the architecture later proves constraining.

Why not the others:
- **Option A:** Too expensive as a first move; it can hide the real bug.
- **Option B:** Better than now, but still mostly heuristic distribution rather than intelligent scheduling.
- **Option D:** Too much ownership cost before proving ccflare cannot host the right policy.
- **Option E:** Useful, but insufficient alone; it reduces burn, not hotspotting.

**Accepted trade-offs:**
- More policy complexity than a simple round-robin toggle
- Need to collect and trust estimated headroom rather than perfect truth
- Some locality/cache affinity may be sacrificed in exchange for better pool longevity

### Implementation Notes

For the selected approach, I would not start with a generic "new balancer." I would build an Anthropic-specific strategy with these primitives:

1. **Observed account state**
   - remaining unified headroom
   - reset time
   - recent burn rate
   - recent 429/degraded events
   - optional concurrency/load score

2. **Short leases instead of permanent stickiness**
   - keep account affinity for a bounded number of requests or short dwell time
   - re-evaluate after lease expiry
   - avoid per-request churn unless data proves it helps

3. **Reserve policy**
   - keep one account colder while the pool is healthy
   - only start consuming reserve capacity once active accounts cross a threshold

4. **Request-cost classification**
   - light / medium / heavy requests based on conversation size, tools, files, model, or known workload traits
   - send heavier work to deepest-headroom accounts

5. **Metrics that decide subscription strategy later**
   - time to first exhausted account
   - successful requests before first exhaustion
   - successful requests over the full rolling window
   - cost per successful request
   - retry/failover rate near exhaustion
   - per-account variance in headroom consumption

That gives you a clean next decision:
- if this strategy fixes most pain, keep ccflare and tune account mix
- if this strategy is constantly fighting generic abstractions, then a bespoke Anthropic router becomes justified by evidence, not by frustration

## Session Notes
**Updated:** 2026-03-26

### Implementation Outcome
- Implemented Anthropic-aware headroom routing in `packages/load-balancer/src/strategies/index.ts`.
- Added targeted tests in `packages/load-balancer/src/strategies/__tests__/anthropic-headroom-strategy.test.ts`.
- Verified with `bun run build`, `bun run typecheck`, and targeted strategy tests.

### Operational Findings
- A separate client-version mismatch caused the observed `invalid x-api-key` 401 failures; upgrading the client resolved the auth issue.
- With the routing fix in place, the next step is observation, not more tuning.
- The current dominant capacity concern appears to be Anthropic overall weekly limits for Opus-heavy usage, not Sonnet-specific limits.

### Current Recommendation
- Run the current setup unchanged for a while and collect real usage data.
- Treat weekly-limited accounts as out of rotation until reset.
- Defer further tuning of priorities, auto-refresh, or account-mix strategy until there is actual data.
- Revisit later whether the right long-term setup is more Max 20x accounts, dedicated account separation, or emergency overflow via extra usage.

### Cache-Aware Refinement (2026-03-26)
- Anthropic prompt cache is per-API-key and expires after ~5 min inactivity.
- Switching accounts while cache is warm costs ~5x ITPM due to cold cache penalty.
- Switching after cache expires (>= 5 min idle) is free — no locality to preserve.
- **Algorithm change:** `shouldKeepAnthropicSession` now checks `last_used` against `ANTHROPIC_CACHE_TTL` (5 min).
  - Cache warm: stay sticky (burst limit and headroom threshold still apply).
  - Cache cold: rebalance freely to highest-headroom account.
- Added `TIME_CONSTANTS.ANTHROPIC_CACHE_TTL` (5 min) to `packages/core/src/constants.ts`.
- Added `isCacheWarm()` helper to SessionStrategy.
- Two new tests: cache-cold rebalance, null-last_used rebalance.
- Existing stickiness test updated to set `last_used` (was testing cache-cold case unintentionally).