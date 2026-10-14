/**
 * The craps table: two dice, a puck that sits on the point, the rolls so far,
 * and buttons for the next roll or for taking odds.
 *
 * Everything shown comes from the server's view (rolls so far, the point, what
 * the odds pay, how the line and the Field ended). The only local state is
 * whether a roll is in flight, to tumble the dice while it is.
 */

import { useEffect, useState } from 'react';
import { CRAPS_POINTS, CRAPS_FIELD } from '../../shared/games';
import type { Action, GameView } from '../../shared/protocol';
import { Actions, Die, Note, useRollOnMount, useTick } from './boardKit';

type CrapsView = Extract<GameView, { game: 'craps' }>;

const ratio = ([win, per]: readonly [number, number]) => `${win}:${per}`;

export function CrapsBoard({
	view,
	busy,
	onAction,
	animate,
}: {
	view: CrapsView;
	busy: boolean;
	onAction: (action: Action) => void;
	animate?: boolean;
}) {
	// Tumble only while a roll is in flight, not while odds are being taken.
	const [rollSent, setRollSent] = useState(false);
	useEffect(() => {
		if (!busy) setRollSent(false);
	}, [busy]);
	const settling = useRollOnMount(!!animate && view.resolved, 900);
	const tumbling = (busy && rollSent) || settling;
	const tick = useTick(tumbling, 80);

	// While the result board's dice are still tumbling, the table is shown as it
	// stood before the last roll: that roll's total, its place in the history, the
	// Field result and the caption would all give the outcome away.
	const rolls = settling ? view.rolls.slice(0, -1) : view.rolls;
	const last = rolls[rolls.length - 1];
	const fieldWon = settling ? null : (view.field?.won ?? null);
	const faces: [number, number] = tumbling ? [(tick * 5) % 6 + 1, (tick * 3 + 2) % 6 + 1] : (last?.dice ?? [5, 5]);
	const pass = view.side === 'pass';
	const settled = view.resolved && !settling;

	const headline = !last
		? pass
			? 'Come-out roll: 7 or 11 wins, 2, 3 or 12 loses.'
			: "Come-out roll: 2 or 3 wins, 7 or 11 loses, 12 is a push."
		: view.point === null
			? `Rolled ${last.total}.`
			: pass
				? `Point is ${view.point}: roll it again before a 7.`
				: `Point is ${view.point}: a 7 before it wins.`;

	return (
		<div className="board">
			<div className="craps">
				<div className="craps__points" aria-label={view.point === null ? 'No point' : `Point ${view.point}`}>
					{CRAPS_POINTS.map((n) => (
						<span key={n} className={`craps__point${view.point === n ? ' craps__point--on' : ''}`}>
							{n}
							{view.point === n ? <span className="craps__puck">ON</span> : null}
						</span>
					))}
				</div>

				<div className="dice-row">
					<Die face={faces[0]} rolling={tumbling} blank={!last && !tumbling} />
					<Die face={faces[1]} rolling={tumbling} blank={!last && !tumbling} />
				</div>
				<p className="board__caption">
					{tumbling ? (
						'Rolling…'
					) : last ? (
						<>
							Total <strong className="board__caption-value">{last.total}</strong>
						</>
					) : (
						'Ready to roll'
					)}
				</p>

				{rolls.length > 1 ? (
					<ol className="craps__history" aria-label="Rolls so far">
						{rolls.map((r, i) => (
							<li
								key={i}
								// The come-out roll only sets the point; colour comes from the rolls after it.
								className={`craps__roll${i > 0 && r.total === 7 ? ' craps__roll--seven' : ''}${i > 0 && r.total === view.point ? ' craps__roll--point' : ''}`}
							>
								{r.total}
							</li>
						))}
					</ol>
				) : null}

				{view.odds > 0 && view.oddsRatio ? (
					<p className="craps__odds">
						Odds bet <strong>{view.odds}</strong> · pays {ratio(view.oddsRatio)} if you win
					</p>
				) : null}
				{view.field ? (
					<p className="craps__odds">
						Field <strong>{view.field.bet}</strong>
						{fieldWon === null
							? ' · decided by the first roll'
							: fieldWon
								? ` · won ${view.field.pays}:1`
								: ' · lost'}
					</p>
				) : null}
			</div>

			{settled ? (
				<Note>
					{view.result === 'win'
						? 'Your line bet wins.'
						: view.result === 'push'
							? 'A push: the line bet comes back.'
							: 'Your line bet loses.'}
				</Note>
			) : (
				<>
					<Note>{headline}</Note>
					<Actions>
						{view.oddsOffer.map((offer) => (
							<button
								key={offer.multiple}
								type="button"
								className="btn"
								disabled={busy}
								onClick={() => onAction({ type: offer.multiple === 1 ? 'BET_1X' : 'BET_2X' })}
							>
								Take {offer.multiple}× odds ({offer.chips})
							</button>
						))}
						<button
							type="button"
							className="btn btn--primary"
							disabled={busy || view.resolved}
							onClick={() => {
								setRollSent(true);
								onAction({ type: 'ROLL' });
							}}
						>
							{view.point === null ? 'Roll' : 'Roll again'}
						</button>
					</Actions>
					{view.oddsOffer.length > 0 && view.oddsRatio ? (
						<p className="faint" style={{ margin: 0, textAlign: 'center' }}>
							Odds pay {ratio(view.oddsRatio)} and carry no house edge.
						</p>
					) : null}
				</>
			)}

			<details className="paytable">
				<summary>How craps pays</summary>
				<ul className="paytable__list">
					<li>
						<span>Pass line</span>
						<span className="faint">1:1 · 1.41% edge</span>
					</li>
					<li>
						<span>Don&apos;t pass (bar 12)</span>
						<span className="faint">1:1 · 1.36% edge</span>
					</li>
					<li>
						<span>Odds on 4 or 10</span>
						<span className="faint">{pass ? '2:1' : '1:2'}</span>
					</li>
					<li>
						<span>Odds on 5 or 9</span>
						<span className="faint">{pass ? '3:2' : '2:3'}</span>
					</li>
					<li>
						<span>Odds on 6 or 8</span>
						<span className="faint">{pass ? '6:5' : '5:6'}</span>
					</li>
					<li>
						<span>Field (first roll)</span>
						<span className="faint">
							3, 4, 9, 10, 11 pay 1:1 · 2 pays {CRAPS_FIELD[2]}:1 · 12 pays {CRAPS_FIELD[12]}:1
						</span>
					</li>
				</ul>
				<p className="faint">
					Odds are optional once a point is set, up to twice your line bet, and win whole chips only (any
					fraction rounds down).
				</p>
			</details>
		</div>
	);
}
