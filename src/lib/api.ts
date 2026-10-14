/**
 * Typed fetch wrappers for the Worker's API.
 *
 * Every call returns the authoritative server state; the client keeps no
 * gameplay state of its own.
 */

import type { Action, ApiError, LeaderboardView, RunView, StatsView } from '../../shared/protocol';

export class ApiRequestError extends Error {
	readonly code: ApiError['code'];

	constructor(code: ApiError['code'], message: string) {
		super(message);
		this.name = 'ApiRequestError';
		this.code = code;
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: {
			...(init?.body ? { 'Content-Type': 'application/json' } : {}),
			...init?.headers,
		},
		// The session cookie is the run identity, so it must ride along.
		credentials: 'same-origin',
	});

	if (!response.ok) {
		let code: ApiError['code'] = 'invalid_action';
		let message = `Request failed (${response.status})`;
		try {
			const body = (await response.json()) as ApiError;
			if (body.error) message = body.error;
			if (body.code) code = body.code;
		} catch {
			// Non-JSON error body; keep the generic message.
		}
		throw new ApiRequestError(code, message);
	}

	return (await response.json()) as T;
}

export function fetchState(): Promise<RunView> {
	return request<RunView>('/api/state');
}

export function sendAction(action: Action): Promise<RunView> {
	return request<RunView>('/api/action', {
		method: 'POST',
		body: JSON.stringify(action),
	});
}

export function fetchLeaderboard(scope: 'today' | 'alltime'): Promise<LeaderboardView> {
	return request<LeaderboardView>(`/api/leaderboard?scope=${scope}`);
}
export function fetchStats(): Promise<StatsView> {
	return request<StatsView>('/api/stats');
}
