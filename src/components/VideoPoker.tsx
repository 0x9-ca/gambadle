/**
 * The Video Poker board: five cards, tap the ones to keep, draw.
 *
 * Which hand is showing, and what it pays, come from the server; this only
 * keeps the player's choice of holds until they press Draw. The round settles
 * on the draw, so the finished board is always the result screen's, where the
 * replaced cards deal in and the held ones stay put.
 */

import { useState } from 'react';
import { VP_KINDS, VP_LABEL, VP_PAYS, type VpKind } from '../../shared/games';
import type { Action, GameView } from '../../shared/protocol';
import { Actions, Note } from './boardKit';
import { PlayingCard } from './PlayingCard';

type VideoPokerView = Extract<GameView, { game: 'videopoker' }>;

export function VideoPokerBoard({
	view,
	busy,
	onAction,
	animate,
}: {
	view: VideoPokerView;
	busy: boolean;
	onAction: (action: Action) => void;
	animate?: boolean;
}) {
	const [hold, setHold] = useState<number[]>([]);
	const drawn = view.stage === 'draw';
	const held = drawn ? view.held : hold;
	const toggle = (index: number) =>
		setHold((current) => (current.includes(index) ? current.filter((i) => i !== index) : [...current, index]));
	const kind = view.kind as VpKind | null;

	return (
		<div className="board">
			<div className="vp__hand">
				{view.hand.cards.map((card, index) => {
					const isHeld = held.includes(index);
					// After the draw only the new cards are dealt in; kept ones stay put.
					const fresh = drawn && !isHeld;
					return (
						<div key={`${index}-${card.rank}${card.suit}`} className="vp__slot">
							<button
								type="button"
								className={`card-pick vp__card${isHeld ? ' vp__card--held' : ''}`}
								aria-pressed={isHeld}
								aria-label={drawn ? undefined : `${isHeld ? 'Release' : 'Hold'} card ${index + 1}`}
								disabled={busy || drawn}
								onClick={() => toggle(index)}
							>
								<PlayingCard
									card={card}
									motion={drawn && !animate ? 'still' : fresh || (!drawn && !animate) ? 'deal' : 'still'}
									delay={fresh ? index * 140 : !drawn ? index * 110 : 0}
								/>
							</button>
							<span className={`vp__held${isHeld ? ' vp__held--on' : ''}`}>{isHeld ? 'HELD' : ''}</span>
						</div>
					);
				})}
			</div>

			<p className={`vp__rank${kind ? ' vp__rank--pays' : ''}`} aria-live="polite">
				{kind ? VP_LABEL[kind] : drawn ? 'No pair of jacks or better' : 'Tap cards to hold'}
				{kind && drawn ? <span className="vp__pays"> pays {VP_PAYS[kind] === 1 ? 'your bet back' : `${VP_PAYS[kind]}×`}</span> : null}
			</p>

			{drawn ? null : (
				<>
					<Note>Keep any cards, then draw. The rest are replaced once.</Note>
					<Actions>
						<button
							type="button"
							className="btn btn--primary vp__draw"
							disabled={busy}
							onClick={() => onAction({ type: 'DRAW', hold: [...hold].sort((a, b) => a - b) })}
						>
							{hold.length === 5 ? 'Stand pat' : 'Draw'}
						</button>
					</Actions>
				</>
			)}

			<details className="paytable">
				<summary>Paytable</summary>
				<table className="vp__paytable">
					<thead>
						<tr>
							<th scope="col">Hand</th>
							<th scope="col">Pays</th>
						</tr>
					</thead>
					<tbody>
						{VP_KINDS.map((k) => (
							<tr key={k} className={k === kind ? 'vp__row--now' : undefined}>
								<th scope="row">{VP_LABEL[k]}</th>
								<td>{VP_PAYS[k] === 1 ? 'bet back' : `${VP_PAYS[k]}×`}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="faint">
					8/5 Jacks or Better. Pays are multiples of your bet, stake included. Playing the best strategy
					returns about 97.3% of every chip staked.
				</p>
			</details>
		</div>
	);
}
