/**
 * Pre-round screens: stake selection, wager confirmation, and the result of the
 * round that just finished.
 */

import { useEffect, useRef, useState } from 'react';
import {
	GAMES_WITHOUT_WAGER_CHOICE,
	MIN_BET,
	TOTAL_ROUNDS,
	type GameId,
	type RoundResult,
	type RunState,
	type Wager,
} from '../../shared/protocol';
import { formatChips, formatDelta } from '../lib/format';
import { revealSeconds } from '../lib/reveal';
import { GameBoard } from './boards';
import { NumberField } from './NumberField';
import { WagerPicker } from './wagers';

// ---------------------------------------------------------------------------
// Bet sizing
// ---------------------------------------------------------------------------

export function BetScreen({
	run,
	busy,
	onBegin,
}: {
	run: RunState;
	busy: boolean;
	onBegin: (bet: number) => void;
}) {
	const [bet, setBet] = useState(() => Math.min(50, run.chips));
	const max = run.chips;

	// Keep the draft in range if the stack changes underneath it.
	useEffect(() => {
		setBet((current) => Math.min(Math.max(current, MIN_BET), Math.max(MIN_BET, max)));
	}, [max]);

	const set = (value: number) => setBet(Math.min(Math.max(MIN_BET, value), Math.max(MIN_BET, max)));
	const step = (delta: number) => set(bet + delta);
	const quick = [...new Set([10, 50, 100, 250, 500, max].filter((v) => v >= MIN_BET && v <= max))];

	return (
		<div className="panel panel--table">
			<h2 className="panel__title">
				Round {Math.min(run.round, TOTAL_ROUNDS)}
				{run.upcoming ? `: ${titleFor(run.upcoming)}` : ` of ${TOTAL_ROUNDS}`}
			</h2>
			{run.upcoming === 'roulette' ? (
				<>
					<p className="panel__sub">
						Spread your chips over as many spots as you like — you choose how much at the table.
					</p>
					<button
						type="button"
						className="btn btn--primary btn--block"
						style={{ marginTop: '0.9rem' }}
						disabled={busy}
						// The whole stack is available; the stake is what gets placed.
						onClick={() => onBegin(max)}
					>
						Go to the table
					</button>
				</>
			) : (
				<>
			<p className="panel__sub">How much are you putting out?</p>

			<div className="bet-input">
				<button type="button" onClick={() => step(-stepSize(bet))} disabled={busy || bet <= MIN_BET} aria-label="Decrease bet">
					−
				</button>
				<NumberField
					className="num-input--bet"
					min={MIN_BET}
					max={max}
					value={bet}
					label="Bet amount"
					onChange={set}
				/>
				<button type="button" onClick={() => step(stepSize(bet))} disabled={busy || bet >= max} aria-label="Increase bet">
					+
				</button>
			</div>

			<div className="quick-bets">
				{quick.map((value) => (
					<button
						key={value}
						type="button"
						className={`btn${bet === value ? ' btn--primary' : ' btn--ghost'}`}
						disabled={busy}
						onClick={() => set(value)}
					>
						{value === max ? 'All in' : formatChips(value)}
					</button>
				))}
			</div>

			<button
				type="button"
				className="btn btn--primary btn--block"
				style={{ marginTop: '0.9rem' }}
				disabled={busy || bet < MIN_BET || bet > max}
				onClick={() => onBegin(bet)}
			>
				Place {formatChips(bet)} chips
			</button>

				</>
			)}

			{run.upcoming !== 'roulette' && bet === max && max > MIN_BET ? (
				<p className="faint" style={{ textAlign: 'center', margin: '0.5rem 0 0' }}>
					All in. A loss ends the run.
				</p>
			) : null}
		</div>
	);
}

/** Betting increments that feel good on a stack of a few thousand. */
function stepSize(bet: number): number {
	if (bet < 25) return 5;
	if (bet < 100) return 10;
	if (bet < 500) return 25;
	return 100;
}

// ---------------------------------------------------------------------------
// Wager confirmation
// ---------------------------------------------------------------------------

export function ChoosingScreen({
	game,
	seedWager,
	bet,
	stack,
	busy,
	onConfirm,
}: {
	game: GameId;
	seedWager: Wager;
	bet: number;
	stack: number;
	busy: boolean;
	onConfirm: (wager: Wager) => void;
}) {
	// Roulette is spread over spots by the player, so it starts with nothing placed.
	const [wager, setWager] = useState<Wager>(
		seedWager.game === 'roulette' ? { game: 'roulette', bets: [] } : seedWager
	);
	const hasChoice = !GAMES_WITHOUT_WAGER_CHOICE.includes(game);
	const autoConfirmed = useRef(false);

	// Games with nothing to choose need no tap: confirm the seeded default as
	// soon as we mount, which keeps them to a single press. The ref stops a
	// re-render from sending the confirm twice.
	useEffect(() => {
		if (hasChoice || autoConfirmed.current) return;
		// Marked sent only when it fires: a cleared timer (an effect re-run) must
		// leave the next run free to schedule it again.
		const timer = setTimeout(() => {
			autoConfirmed.current = true;
			onConfirm(seedWager);
		}, 700);
		return () => clearTimeout(timer);
	}, [hasChoice, seedWager, onConfirm]);

	return (
		<div className="panel panel--table">
			<h2 className="panel__title">{titleFor(game)}</h2>
			<p className="panel__sub">
				{game === 'roulette'
					? `Place up to ${formatChips(bet)} chips on any spots`
					: `${formatChips(bet)} chips on the table`}
			</p>

			{hasChoice ? (
				<>
					<WagerPicker game={game} wager={wager} stack={stack} bet={bet} onChange={setWager} />
					<button
						type="button"
						className="btn btn--primary btn--block"
						style={{ marginTop: '1rem' }}
						disabled={busy || (wager.game === 'roulette' && wager.bets.length === 0)}
						onClick={() => onConfirm(wager)}
					>
						{wager.game === 'roulette'
							? `Spin with ${formatChips(wager.bets.reduce((sum, c) => sum + c.amount, 0))} placed`
							: 'Confirm'}
					</button>
				</>
			) : (
				<p className="faint" style={{ textAlign: 'center' }}>
					{busy ? 'Dealing…' : 'Opening the table…'}
				</p>
			)}
		</div>
	);
}

function titleFor(game: GameId): string {
	return (
		{
			blackjack: 'Blackjack',
			roulette: 'Roulette',
			baccarat: 'Baccarat',
			coinflip: 'Coin Flip',
			dice: 'Dice',
			slots: 'Slots',
			threecard: 'Three Card Poker',
			ultimate: "Ultimate Texas Hold'em",
			paigow: 'Pai Gow Poker',
		}[game]
	);
}

// ---------------------------------------------------------------------------
// Round result
// ---------------------------------------------------------------------------


export function ResultPanel({ result }: { result: RoundResult }) {
	const won = result.net > 0;
	const push = result.net === 0;
	const tone = push ? 'push' : won ? 'win' : 'loss';
	const delay = revealSeconds(result);

	return (
		<div className="panel panel--table result">
			{/* The board goes first so the reveal is watched, not spoiled by the verdict. */}
			{result.view ? (
				<div className="board--static">
					<GameBoard view={result.view} busy={false} onAction={() => {}} animate />
				</div>
			) : null}
			<div className={`reveal${result.view ? ' result__verdict' : ''}`} style={{ animationDelay: `${delay}s` }}>
				<p
					className={`result__headline result__headline--${tone} result__headline--pop`}
					style={{ animationDelay: `${delay}s` }}
				>
					{push ? 'PUSH' : won ? 'WIN' : 'LOSS'}
				</p>
				<p className={`delta delta--${tone}`} style={{ margin: '0.2rem 0' }}>
					{formatDelta(result.net)}
				</p>
				<p className="result__detail">
					{/* The poker games' recorded bet is the ante; their raises ride on top. */}
					{titleFor(result.game)} · {formatChips(result.bet)}{' '}
					{result.game === 'threecard' || result.game === 'ultimate' ? 'ante' : 'staked'}
					{result.doubled ? ' · doubled' : ''}
				</p>
				<p className="result__detail">{result.detail}</p>
			</div>
		</div>
	);
}
