import { isAccountAvailable, TIME_CONSTANTS } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";
import {
	PROVIDER_NAMES,
	requiresSessionDurationTracking,
} from "@better-ccflare/types";

export class SessionStrategy implements LoadBalancingStrategy {
	private static readonly ANTHROPIC_SESSION_BURST_REQUEST_LIMIT = 50;
	private static readonly ANTHROPIC_SESSION_REMAINING_SWITCH_THRESHOLD = 2;
	private sessionDurationMs: number;
	private store: StrategyStore | null = null;
	private log = new Logger("SessionStrategy");

	constructor(
		sessionDurationMs: number = TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT,
	) {
		this.sessionDurationMs = sessionDurationMs;
	}

	initialize(store: StrategyStore): void {
		this.store = store;
	}

	private resetSessionIfExpired(account: Account): void {
		const now = Date.now();

		// Check if session has exceeded the fixed duration (only for providers that require session duration tracking)
		const fixedDurationExpired =
			requiresSessionDurationTracking(account.provider) &&
			(!account.session_start ||
				now - account.session_start >= this.sessionDurationMs);

		// Check if the account's rate limit window has reset
		// This helps Anthropic accounts better utilize their usage windows
		// Usage windows: Anthropic accounts with proactive rate limit headers (usage-based accounts)
		// No usage windows: Other account types or Anthropic console keys without usage windows
		const rateLimitWindowReset =
			account.provider === PROVIDER_NAMES.ANTHROPIC &&
			account.rate_limit_reset &&
			account.rate_limit_reset < now - 1000;

		if (fixedDurationExpired || rateLimitWindowReset) {
			if (this.store) {
				const wasExpired = account.session_start !== null;
				const resetReason = rateLimitWindowReset
					? "rate limit window reset"
					: "fixed duration expired";
				this.log.info(
					wasExpired
						? `Session expired for account ${account.name} due to ${resetReason}, starting new session`
						: `Starting new session for account ${account.name}`
				);
				this.store.resetAccountSession(account.id, now);

				account.session_start = now;
				account.session_request_count = 0;
			}
		}
	}

	/**
	 * Determines if an account has an active session based on provider requirements
	 * For Anthropic providers: checks if session is within the 5-hour window
	 * For other providers: always returns false (no session stickiness for pay-as-you-go)
	 * @param account The account to check
	 * @param now Current timestamp
	 * @returns true if session is active (Anthropic only), false otherwise
	 */
	private hasActiveSession(account: Account, now: number): boolean {
		if (!requiresSessionDurationTracking(account.provider)) {
			return false;
		}

		return !!account.session_start && now - account.session_start < this.sessionDurationMs;
	}

	private compareByPriority(a: Account, b: Account): number {
		return a.priority - b.priority;
	}

	private isAnthropicAccount(account: Account): boolean {
		return account.provider === PROVIDER_NAMES.ANTHROPIC;
	}

	private getKnownRemaining(account: Account): number | null {
		return typeof account.rate_limit_remaining === "number"
			? account.rate_limit_remaining
			: null;
	}

	private getKnownReset(account: Account): number | null {
		return typeof account.rate_limit_reset === "number"
			? account.rate_limit_reset
			: null;
	}

	private compareAnthropicAccounts(a: Account, b: Account): number {
		const remainingA = this.getKnownRemaining(a);
		const remainingB = this.getKnownRemaining(b);

		if (remainingA !== null && remainingB !== null && remainingA !== remainingB) {
			return remainingB - remainingA;
		}

		// An account with no rate-limit data has never been used (or headers are stale),
		// meaning it likely has full capacity. Prefer it over one we know has been consumed.
		if (remainingA !== null && remainingB === null) {
			return 1;
		}

		if (remainingA === null && remainingB !== null) {
			return -1;
		}

		const resetA = this.getKnownReset(a);
		const resetB = this.getKnownReset(b);

		if (resetA !== null && resetB !== null && resetA !== resetB) {
			return resetA - resetB;
		}

		// Same logic: no reset data means the account hasn't hit any limits.
		// Prefer the fresh/unknown account over one with a known reset window.
		if (resetA !== null && resetB === null) {
			return 1;
		}

		if (resetA === null && resetB !== null) {
			return -1;
		}

		const priorityComparison = this.compareByPriority(a, b);
		if (priorityComparison !== 0) {
			return priorityComparison;
		}

		return (a.last_used ?? 0) - (b.last_used ?? 0);
	}

	private isCacheWarm(account: Account, now: number): boolean {
		return (
			account.last_used !== null &&
			now - account.last_used < TIME_CONSTANTS.ANTHROPIC_CACHE_TTL
		);
	}

	private shouldKeepAnthropicSession(
		activeAccount: Account,
		candidateAccount: Account,
		now: number,
	): boolean {
		if (activeAccount.id === candidateAccount.id) {
			return true;
		}

		// If the prompt cache is cold, switching accounts is free —
		// no locality benefit to preserve, so pick by headroom alone.
		if (!this.isCacheWarm(activeAccount, now)) {
			return false;
		}

		if (
			activeAccount.session_request_count >=
			SessionStrategy.ANTHROPIC_SESSION_BURST_REQUEST_LIMIT
		) {
			return false;
		}

		const activeRemaining = this.getKnownRemaining(activeAccount);
		const candidateRemaining = this.getKnownRemaining(candidateAccount);

		if (activeRemaining === null || candidateRemaining === null) {
			return activeAccount.priority <= candidateAccount.priority;
		}

		return (
			candidateRemaining - activeRemaining <=
			SessionStrategy.ANTHROPIC_SESSION_REMAINING_SWITCH_THRESHOLD
		);
	}

	private rankAnthropicAccounts(
		availableAccounts: Account[],
		activeAccount: Account | null,
		now: number,
	): Account[] {
		const rankedAccounts = [...availableAccounts].sort((a, b) =>
			this.compareAnthropicAccounts(a, b),
		);

		if (!activeAccount) {
			return rankedAccounts;
		}

		const activeAvailableAccount = rankedAccounts.find(
			(account) => account.id === activeAccount.id,
		);

		if (!activeAvailableAccount) {
			return rankedAccounts;
		}

		const leadingAccount = rankedAccounts[0];
		if (
			!leadingAccount ||
			!this.shouldKeepAnthropicSession(
				activeAvailableAccount,
				leadingAccount,
				now,
			)
		) {
			return rankedAccounts;
		}

		return [
			activeAvailableAccount,
			...rankedAccounts.filter(
				(account) => account.id !== activeAvailableAccount.id,
			),
		];
	}

	private rankAvailableAccounts(
		availableAccounts: Account[],
		activeAccount: Account | null,
		now: number,
	): Account[] {
		if (availableAccounts.length <= 1) {
			return availableAccounts;
		}

		if (availableAccounts.every((account) => this.isAnthropicAccount(account))) {
			return this.rankAnthropicAccounts(availableAccounts, activeAccount, now);
		}

		if (activeAccount) {
			const activeAvailableAccount = availableAccounts.find(
				(account) => account.id === activeAccount.id,
			);

			if (activeAvailableAccount) {
				const higherPriorityAccount = availableAccounts
					.filter(
						(account) =>
							account.id !== activeAvailableAccount.id &&
							account.priority < activeAvailableAccount.priority,
					)
					.sort((a, b) => this.compareByPriority(a, b))[0];

				if (!higherPriorityAccount) {
					return [
						activeAvailableAccount,
						...availableAccounts
							.filter(
								(account) => account.id !== activeAvailableAccount.id,
							)
							.sort((a, b) => this.compareByPriority(a, b)),
					];
				}

				this.log.info(
					`Skipping session on account ${activeAvailableAccount.name} (priority: ${activeAvailableAccount.priority}) — higher-priority account ${higherPriorityAccount.name} (priority: ${higherPriorityAccount.priority}) is available`,
				);
			}
		}

		return [...availableAccounts].sort((a, b) => this.compareByPriority(a, b));
	}

	select(accounts: Account[], meta: RequestMeta): Account[] {
		const now = Date.now();

		const bypassHeader = meta.headers?.get("x-better-ccflare-bypass-session");
		const bypassSession = bypassHeader === "true";

		this.log.info(
			`Bypass header: ${bypassHeader}, bypassSession: ${bypassSession}`,
		);

		if (bypassSession) {
			this.log.info("Session tracking bypassed due to bypass header");
		}

		const availabilityCache = new Map<string, boolean>();
		const getCachedAvailability = (account: Account): boolean => {
			if (!availabilityCache.has(account.id)) {
				availabilityCache.set(account.id, isAccountAvailable(account, now));
			}
			return availabilityCache.get(account.id) || false;
		};

		const fallbackCandidates = this.checkForAutoFallbackAccounts(accounts, now);
		if (fallbackCandidates.length > 0) {
			const chosenFallback = fallbackCandidates[0];
			if (!bypassSession) {
				this.resetSessionIfExpired(chosenFallback);
			}
			this.log.info(
				`Auto-fallback triggered to account ${chosenFallback.name} (priority: ${chosenFallback.priority}, auto-fallback enabled)`,
			);

			if (chosenFallback.paused && this.store?.resumeAccount) {
				this.log.info(
					`Unpausing account ${chosenFallback.name} due to auto-fallback reactivation`,
				);
				this.store.resumeAccount(chosenFallback.id);
				chosenFallback.paused = false;
			}

			const others = accounts
				.filter(
					(account) =>
						account.id !== chosenFallback.id && getCachedAvailability(account),
				)
				.sort((a, b) => this.compareByPriority(a, b));
			return [chosenFallback, ...others];
		}

		let activeAccount: Account | null = null;
		let mostRecentSessionStart = 0;

		for (const account of accounts) {
			if (
				this.hasActiveSession(account, now) &&
				account.session_start &&
				account.session_start > mostRecentSessionStart
			) {
				activeAccount = account;
				mostRecentSessionStart = account.session_start;
			}
		}

		if (activeAccount) {
			this.log.debug(
				`Active session found for account ${activeAccount.name} (provider: ${activeAccount.provider})`,
			);
		} else {
			this.log.debug(
				"No active sessions found, will select from available accounts",
			);
		}

		const availableAccounts = accounts.filter((account) =>
			getCachedAvailability(account),
		);

		if (availableAccounts.length === 0) {
			return [];
		}

		const rankedAccounts = this.rankAvailableAccounts(
			availableAccounts,
			bypassSession ? null : activeAccount,
			now,
		);
		const chosenAccount = rankedAccounts[0];

		if (!chosenAccount) {
			return [];
		}

		if (!bypassSession) {
			this.resetSessionIfExpired(chosenAccount);
		}

		if (activeAccount && chosenAccount.id === activeAccount.id) {
			this.log.info(
				`Continuing session for account ${activeAccount.name} (${activeAccount.session_request_count} requests in session)`,
			);
		} else if (
			activeAccount &&
			this.isAnthropicAccount(activeAccount) &&
			this.isAnthropicAccount(chosenAccount)
		) {
			const cacheStatus = this.isCacheWarm(activeAccount, now) ? "cache-warm" : "cache-cold";
			this.log.info(
				`Switching Anthropic traffic from ${activeAccount.name} to ${chosenAccount.name} (${cacheStatus}, remaining: ${activeAccount.rate_limit_remaining ?? "unknown"} -> ${chosenAccount.rate_limit_remaining ?? "unknown"})`,
			);
		}

		return [chosenAccount, ...rankedAccounts.filter((account) => account.id !== chosenAccount.id)];
	}

	/**
	 * Check for higher priority accounts that have auto-fallback enabled and have become available
	 * due to rate limit reset
	 */
	private checkForAutoFallbackAccounts(
		accounts: Account[],
		now: number,
	): Account[] {
		const resetAccounts = accounts.filter((account) => {
			if (!account.auto_fallback_enabled) return false;

			const anthropicWindowReset =
				account.provider === PROVIDER_NAMES.ANTHROPIC &&
				account.rate_limit_reset &&
				account.rate_limit_reset < now - 1000;

			const notRateLimited =
				!account.rate_limited_until || account.rate_limited_until <= now;

			return anthropicWindowReset && notRateLimited;
		});

		if (resetAccounts.length === 0) return [];

		return resetAccounts.sort((a, b) => this.compareByPriority(a, b));
	}
}
