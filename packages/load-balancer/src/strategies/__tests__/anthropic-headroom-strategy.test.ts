import { beforeEach, describe, expect, it } from "bun:test";
import { SessionStrategy } from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";

class MockStrategyStore implements StrategyStore {
	resetAccountSession(): void {}
	resumeAccount(): void {}
}

function createAccount(overrides: Partial<Account>): Account {
	const now = Date.now();

	return {
		id: overrides.id ?? "account-id",
		name: overrides.name ?? "account-name",
		provider: overrides.provider ?? "anthropic",
		api_key: overrides.api_key ?? null,
		refresh_token: overrides.refresh_token ?? "refresh-token",
		access_token: overrides.access_token ?? "access-token",
		expires_at: overrides.expires_at ?? now + 60 * 60 * 1000,
		request_count: overrides.request_count ?? 0,
		total_requests: overrides.total_requests ?? 0,
		last_used: overrides.last_used ?? null,
		created_at: overrides.created_at ?? now,
		rate_limited_until: overrides.rate_limited_until ?? null,
		session_start: overrides.session_start ?? null,
		session_request_count: overrides.session_request_count ?? 0,
		paused: overrides.paused ?? false,
		rate_limit_reset: overrides.rate_limit_reset ?? null,
		rate_limit_status: overrides.rate_limit_status ?? null,
		rate_limit_remaining: overrides.rate_limit_remaining ?? null,
		priority: overrides.priority ?? 0,
		auto_fallback_enabled: overrides.auto_fallback_enabled ?? false,
		auto_refresh_enabled: overrides.auto_refresh_enabled ?? false,
		custom_endpoint: overrides.custom_endpoint ?? null,
		model_mappings: overrides.model_mappings ?? null,
		cross_region_mode: overrides.cross_region_mode ?? null,
	};
}

describe("SessionStrategy Anthropic headroom routing", () => {
	let strategy: SessionStrategy;
	let meta: RequestMeta;

	beforeEach(() => {
		strategy = new SessionStrategy(5 * 60 * 60 * 1000);
		strategy.initialize(new MockStrategyStore());
		meta = {
			id: "request-id",
			timestamp: Date.now(),
			headers: new Headers(),
			path: "/v1/messages",
			method: "POST",
		};
	});

	it("prefers the Anthropic account with the highest observed remaining headroom", () => {
		const lowerRemaining = createAccount({
			id: "anthropic-low",
			name: "anthropic-low",
			priority: 0,
			rate_limit_remaining: 5,
			rate_limit_reset: Date.now() + 20_000,
		});
		const higherRemaining = createAccount({
			id: "anthropic-high",
			name: "anthropic-high",
			priority: 1,
			rate_limit_remaining: 12,
			rate_limit_reset: Date.now() + 40_000,
		});

		const result = strategy.select([lowerRemaining, higherRemaining], meta);

		expect(result.map((account) => account.id)).toEqual([
			"anthropic-high",
			"anthropic-low",
		]);
	});

	it("keeps the active Anthropic session when cache is warm, headroom is close, and burst budget remains", () => {
		const activeAccount = createAccount({
			id: "anthropic-active",
			name: "anthropic-active",
			session_start: Date.now() - 60_000,
			session_request_count: 2,
			last_used: Date.now() - 60_000, // cache is warm (< 5 min)
			priority: 1,
			rate_limit_remaining: 9,
			rate_limit_reset: Date.now() + 30_000,
		});
		const slightlyHealthierAccount = createAccount({
			id: "anthropic-other",
			name: "anthropic-other",
			priority: 0,
			rate_limit_remaining: 10,
			rate_limit_reset: Date.now() + 60_000,
		});

		const result = strategy.select([activeAccount, slightlyHealthierAccount], meta);

		expect(result[0]?.id).toBe("anthropic-active");
	});

	it("rebalances to highest-headroom account when cache is cold (idle > 5 min)", () => {
		const activeAccount = createAccount({
			id: "anthropic-active",
			name: "anthropic-active",
			session_start: Date.now() - 60_000,
			session_request_count: 1,
			last_used: Date.now() - 6 * 60 * 1000, // cache is cold (> 5 min)
			priority: 0,
			rate_limit_remaining: 9,
			rate_limit_reset: Date.now() + 30_000,
		});
		const healthierAccount = createAccount({
			id: "anthropic-healthier",
			name: "anthropic-healthier",
			priority: 1,
			rate_limit_remaining: 15,
			rate_limit_reset: Date.now() + 60_000,
		});

		const result = strategy.select([activeAccount, healthierAccount], meta);

		// Cache is cold, so switching is free — pick by headroom
		expect(result[0]?.id).toBe("anthropic-healthier");
	});

	it("rebalances when account has never been used (last_used is null)", () => {
		const activeAccount = createAccount({
			id: "anthropic-active",
			name: "anthropic-active",
			session_start: Date.now() - 60_000,
			session_request_count: 1,
			last_used: null, // never used — cache cannot be warm
			priority: 0,
			rate_limit_remaining: 9,
			rate_limit_reset: Date.now() + 30_000,
		});
		const healthierAccount = createAccount({
			id: "anthropic-healthier",
			name: "anthropic-healthier",
			priority: 1,
			rate_limit_remaining: 15,
			rate_limit_reset: Date.now() + 60_000,
		});

		const result = strategy.select([activeAccount, healthierAccount], meta);

		expect(result[0]?.id).toBe("anthropic-healthier");
	});

	it("switches away from the active Anthropic session once the burst budget is exhausted", () => {
		const exhaustedBurstAccount = createAccount({
			id: "anthropic-active",
			name: "anthropic-active",
			session_start: Date.now() - 60_000,
			session_request_count: 3,
			last_used: Date.now() - 60_000, // cache is warm — but burst limit hit
			priority: 0,
			rate_limit_remaining: 9,
			rate_limit_reset: Date.now() + 30_000,
		});
		const healthierAccount = createAccount({
			id: "anthropic-healthier",
			name: "anthropic-healthier",
			priority: 1,
			rate_limit_remaining: 15,
			rate_limit_reset: Date.now() + 60_000,
		});

		const result = strategy.select([exhaustedBurstAccount, healthierAccount], meta);

		expect(result[0]?.id).toBe("anthropic-healthier");
	});

	it("preserves priority routing for non-Anthropic providers", () => {
		const activeNonAnthropic = createAccount({
			id: "zai-active",
			name: "zai-active",
			provider: "zai",
			priority: 2,
			session_start: Date.now() - 60_000,
		});
		const higherPriorityNonAnthropic = createAccount({
			id: "zai-priority",
			name: "zai-priority",
			provider: "zai",
			priority: 0,
		});

		const result = strategy.select(
			[activeNonAnthropic, higherPriorityNonAnthropic],
			meta,
		);

		expect(result[0]?.id).toBe("zai-priority");
	});
});
