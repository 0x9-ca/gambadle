/**
 * The player's own record across every finished run: best stack, average,
 * busts, day streak, and how each game has gone for them.
 *
 * Kept on the server per session (the same identity as the ranked-run rule),
 * so it follows the player across reloads but not across devices.
 */

import { useEffect, useState } from 'react';
import type { StatsView } from '../../shared/protocol';
import { fetchStats } from '../lib/api';
import { formatChips, formatDay, formatDelta, SHORT_TITLE } from '../lib/format';

export function Stats({ refreshKey }: { refreshKey: string }) {
	const [stats, setStats] = useState<StatsView | null>(null);

	// Refetched whenever a run finishes (the key changes), not polled.
	useEffect(() => {
		let cancelled = false;
		fetchStats()
			.then((next) => {
				if (!cancelled) setStats(next);
			})
			.catch(() => {
				// Stats are optional; on failure the panel simply stays hidden.
			});
		return () => {
			cancelled = true;
		};
	}, [refreshKey]);

	if (!stats || stats.runs === 0) return null;

	return (
		<details className="panel stats">
			<summary className="stats__summary">
				<span className="panel__title">Your stats</span>
				<span className="faint">
					{stats.runs} run{stats.runs === 1 ? '' : 's'}
					{stats.streak > 1 ? ` · ${stats.streak}-day streak` : ''}
				</span>
			</summary>
			<div className="stats__tiles">
				<Tile label="Best" value={stats.best ? formatChips(stats.best.chips) : '—'} note={stats.best ? formatDay(stats.best.day) : undefined} />
				<Tile label="Average" value={stats.average !== null ? formatChips(stats.average) : '—'} />
				<Tile label="Day streak" value={String(stats.streak)} />
				<Tile label="Busts" value={`${stats.busts}/${stats.runs}`} />
			</div>
			<p className="faint" style={{ margin: '0.6rem 0 0.4rem' }}>
				Overall {formatDelta(stats.netTotal)} chips against a fresh 1,000 each run.
			</p>
			<table className="stats__games">
				<thead>
					<tr>
						<th scope="col">Game</th>
						<th scope="col">Won</th>
						<th scope="col">Net</th>
					</tr>
				</thead>
				<tbody>
					{stats.games.map((g) => (
						<tr key={g.game}>
							<th scope="row">{SHORT_TITLE[g.game]}</th>
							<td>
								{g.won}/{g.played}{' '}
								<span className="faint">({Math.round((g.won / g.played) * 100)}%)</span>
							</td>
							<td className={g.net > 0 ? 'delta--win' : g.net < 0 ? 'delta--loss' : 'delta--push'}>{formatDelta(g.net)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</details>
	);
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
	return (
		<div className="stats__tile">
			<span className="board__label">{label}</span>
			<span className="stats__value">{value}</span>
			{note ? <span className="faint">{note}</span> : null}
		</div>
	);
}
