/**
 * "How you did today": a finished ranked run set against everyone else's.
 *
 * Every ranked run is dealt the same games with the same outcomes, so a round
 * compares directly: how many players won it, what the field made per chip it
 * bet, and what you made. Only shown for a ranked run; the numbers come from
 * the server and are aggregates, never another player's run.
 */

import { useEffect, useState } from 'react';
import type { DailyView } from '../../shared/protocol';
import { fetchDaily } from '../lib/api';
import { formatDelta, SHORT_TITLE } from '../lib/format';

/** 0.456 -> "46%", with a plus sign for gains when asked. */
const percent = (value: number, signed = false): string => {
	const n = Math.round(value * 100);
	return `${signed && n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}%`;
};

export function Daily() {
	const [daily, setDaily] = useState<DailyView | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchDaily()
			.then((next) => {
				if (!cancelled) setDaily(next);
			})
			.catch(() => {
				// A comparison is a nicety; if it cannot load the panel just stays away.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	if (!daily || !daily.you) return null;
	const others = daily.players - 1;

	return (
		<section className="panel daily" aria-labelledby="daily-title">
			<h2 className="panel__title" id="daily-title">
				How you did today
			</h2>
			<p className="panel__sub">
				{daily.you.ahead === null
					? "You're the first ranked run finished today. Check back later to see how it compares."
					: `You finished ahead of ${percent(daily.you.ahead)} of the ${others} other ${others === 1 ? 'player' : 'players'}.`}
			</p>
			<table className="daily__table">
				<caption className="faint">
					Everyone who finished a ranked run today got the same games and the same outcomes. Returns are net chips per chip bet.
				</caption>
				<thead>
					<tr>
						<th scope="col">Round</th>
						<th scope="col">You</th>
						<th scope="col">Field</th>
						<th scope="col">Won it</th>
					</tr>
				</thead>
				<tbody>
					{daily.rounds.map((r) => {
						// A marker only when the gap shows at the precision printed (a whole percent).
						const gap = r.you.ret !== null && r.avgReturn !== null ? r.you.ret - r.avgReturn : 0;
						const better = Math.abs(gap) < 0.005 ? null : gap > 0;
						return (
							<tr key={r.round}>
								<th scope="row">
									<span className="faint">{r.round}</span> {SHORT_TITLE[r.game]}
								</th>
								<td className={r.you.net > 0 ? 'delta--win' : r.you.net < 0 ? 'delta--loss' : 'delta--push'}>
									{formatDelta(r.you.net)}
									{r.you.ret !== null ? <span className="faint"> {percent(r.you.ret, true)}</span> : null}
								</td>
								<td>
									{r.avgReturn !== null ? percent(r.avgReturn, true) : '—'}
									{better === null ? null : (
										<span className={better ? 'delta--win' : 'delta--loss'} aria-label={better ? 'you beat the field' : 'the field beat you'}>
											{' '}
											{better ? '▲' : '▼'}
										</span>
									)}
								</td>
								<td>
									{percent(r.winRate)}
									{r.players > 1 ? <span className="faint"> of {r.players}</span> : null}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</section>
	);
}
