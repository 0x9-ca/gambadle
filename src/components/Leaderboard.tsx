/**
 * Leaderboards: today's board and the all-time best.
 *
 * Both are read from the Worker and cached client-side per scope for the life of
 * the session, refetched on demand — these change on other people's runs, so
 * polling would be wasteful.
 */

import { useCallback, useEffect, useState } from 'react';
import type { LeaderboardView } from '../../shared/protocol';
import { ApiRequestError, fetchLeaderboard } from '../lib/api';
import { formatChips, formatDay } from '../lib/format';

type Scope = 'today' | 'alltime';

const cache = new Map<Scope, LeaderboardView>();

export function Leaderboard({ highlight }: { highlight?: 'submitted' }) {
	const [scope, setScope] = useState<Scope>('today');
	const [view, setView] = useState<LeaderboardView | null>(() => cache.get('today') ?? null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (next: Scope) => {
		const cached = cache.get(next);
		if (cached) setView(cached);
		setError(null);
		try {
			const fresh = await fetchLeaderboard(next);
			cache.set(next, fresh);
			setView(fresh);
		} catch (cause) {
			if (cause instanceof ApiRequestError) setError(cause.message);
			else setError('Could not load the board');
		}
	}, []);

	// `highlight` means we just submitted, so the board is definitely stale.
	useEffect(() => {
		cache.clear();
		void load(scope);
	}, [scope, load, highlight]);

	const entries = view?.entries ?? [];
	const you = view?.you ?? null;

	return (
		<div className="panel">
			<div className="tabs" role="tablist" aria-label="Leaderboard scope">
				{(
					[
						{ id: 'today', label: 'Today' },
						{ id: 'alltime', label: 'All time' },
					] as const
				).map((tab) => (
					<button
						key={tab.id}
						type="button"
						role="tab"
						aria-selected={scope === tab.id}
						className={`tab${scope === tab.id ? ' tab--on' : ''}`}
						onClick={() => setScope(tab.id)}
					>
						{tab.label}
					</button>
				))}
			</div>

			{error ? (
				<p className="error" style={{ marginTop: '0.7rem' }}>
					{error}
				</p>
			) : null}

			{!view ? (
				<p className="faint" style={{ textAlign: 'center', margin: '1rem 0 0' }}>
					Loading the board…
				</p>
			) : entries.length === 0 ? (
				<p className="faint" style={{ textAlign: 'center', margin: '1rem 0 0' }}>
					Nobody has posted a score yet. Be the first.
				</p>
			) : (
				<div className="board-list" style={{ marginTop: '0.7rem' }}>
					{entries.map((entry) => (
						<div
							key={`${entry.rank}-${entry.name}`}
							className={`board-row${you && entry.name === you.name ? ' board-row--you' : ''}`}
						>
							<span className={`board-row__rank${entry.rank === 1 ? ' board-row__rank--1' : ''}`}>
								{entry.rank}
							</span>
							<span className="board-row__name">
								{entry.name}
								{subtitleFor(entry, scope)}
							</span>
							<span className="board-row__chips">{formatChips(entry.chips)}</span>
						</div>
					))}
				</div>
			)}

			{view ? (
				<p className="faint" style={{ textAlign: 'center', margin: '0.8rem 0 0' }}>
					{scope === 'today'
						? `Today in ET · ${formatDay(view.day)}`
						: `Best bankroll per name, all time`}
				</p>
			) : null}
		</div>
	);
}

function subtitleFor(entry: LeaderboardView['entries'][number], scope: Scope) {
	if (scope === 'alltime') {
		return <small>{formatDay(entry.day)}</small>;
	}
	if (entry.bust) {
		return <small>busted · {formatChips(entry.chips)}</small>;
	}
	if (entry.rounds !== undefined) {
		return <small>{entry.rounds} rounds</small>;
	}
	return null;
}