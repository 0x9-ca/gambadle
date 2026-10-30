/**
 * Pre-round screens: stake selection, wager confirmation, and the result of the
 * round that just finished.
 */

import { useEffect, useRef, useState } from 'react';
import { SLOT_SPINS } from '../../shared/games';
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
import { restoreWager, saveWager } from '../lib/lastWager';
import { revealSeconds } from '../lib/reveal';
import { useRevealed } from '../lib/useRevealed';
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
	// The slot machines play five spins a round and ask for the bet on each; the
	// round's stake is five times it. Everywhere else the bet is the stake.
	const perSpin = run.upcoming === 'slots' || run.upcoming === 'megaslots';
	const spins = perSpin ? SLOT_SPINS : 1;
	const max = Math.max(MIN_BET, Math.floor(run.chips / spins));
	const [bet, setBet] = useState(() => Math.min(perSpin ? 10 : 50, max));

	// Keep the draft in range if the stack changes underneath it.
	useEffect(() => {
		setBet((current) => Math.min(Math.max(current, MIN_BET), Math.max(MIN_BET, max)));
	}, [max]);

	const set = (value: number) => setBet(Math.min(Math.max(MIN_BET, value), Math.max(MIN_BET, max)));
	const step = (delta: number) => set(bet + delta);
	const quick = [...new Set((perSpin ? [1, 5, 10, 25, 50, 100, max] : [10, 50, 100, 250, 500, max]).filter((v) => v >= MIN_BET && v <= max))];

	return (
		<div className="panel panel--table">
			<h2 className="panel__title">
				Round {run.testGame ? run.round : Math.min(run.round, TOTAL_ROUNDS)}
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
			<p className="panel__sub">
				{perSpin
					? `${SLOT_SPINS} spins a round. Pick your bet per spin; your stake is ${SLOT_SPINS} times it.`
					: (ANTE_NOTE[run.upcoming ?? ''] ?? 'How much are you putting out?')}
			</p>

			<div className="bet-input">
				<button type="button" onClick={() => step(-stepSize(bet))} disabled={busy || bet <= MIN_BET} aria-label={perSpin ? 'Decrease bet per spin' : 'Decrease bet'}>
					−
				</button>
				<NumberField
					className="num-input--bet"
					min={MIN_BET}
					max={max}
					value={bet}
					label={perSpin ? 'Bet per spin' : 'Bet amount'}
					onChange={set}
				/>
				<button type="button" onClick={() => step(stepSize(bet))} disabled={busy || bet >= max} aria-label={perSpin ? 'Increase bet per spin' : 'Increase bet'}>
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
				onClick={() => onBegin(bet * spins)}
			>
				{perSpin
					? `Place ${formatChips(bet)} a spin · ${formatChips(bet * spins)} chips in all`
					: `${run.upcoming === 'craps' ? 'Line bet' : run.upcoming && ANTE_NOTE[run.upcoming] ? 'Ante' : 'Place'} ${formatChips(bet)} chips`}
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

/**
 * In the poker games the bet is only the ante: more goes out with it, and the
 * engine caps an all-in so the rest can be covered. Said up front, here,
 * rather than discovered on the wager screen.
 */
const ANTE_NOTE: Partial<Record<string, string>> = {
	craps:
		'Your bet is the line bet. Once a point is set you can add free odds up to 2× it, so up to three times it is at risk (all in bets a third of your stack).',
	threecard: 'Your bet is the ante. Playing the hand adds an equal Play bet, so up to twice it is at risk (all in antes half your stack).',
	ultimate:
		"Your bet is the ante. A matching Blind goes out with it and you can raise up to 4x, so up to six times it is at risk (all in antes a sixth of your stack).",
};

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
	// Roulette is spread over spots by the player, so it starts with nothing
	// placed (its picker offers the last spread). Other games start from the
	// last wager made on them, refitted to this bet and stack.
	const [wager, setWager] = useState<Wager>(() =>
		seedWager.game === 'roulette'
			? { game: 'roulette', bets: [] }
			: (restoreWager(game, bet, stack) ?? seedWager)
	);
	const confirm = (chosen: Wager) => {
		saveWager(chosen);
		onConfirm(chosen);
	};
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
					: game === 'slots' || game === 'megaslots'
						? `${SLOT_SPINS} spins at ${formatChips(bet / SLOT_SPINS)} · ${formatChips(bet)} chips on the table`
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
						onClick={() => confirm(wager)}
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
			megaslots: 'Mega Slots',
			videopoker: 'Video Poker',
			craps: 'Craps',
		}[game]
	);
}

// ---------------------------------------------------------------------------
// Round result
// ---------------------------------------------------------------------------


/**
 * A buzz when the verdict lands, where the device supports it (Android
 * browsers do, iOS Safari does not): a double tap for a win, one long buzz for
 * a loss of at least a quarter of the stack. Skipped under reduced motion.
 */
function useVerdictBuzz(result: RoundResult, chips: number, delay: number): void {
	useEffect(() => {
		if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
		if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
		const before = chips - result.net;
		const pattern =
			result.net > 0 ? [30, 70, 30] : result.net < 0 && -result.net >= before / 4 ? [180] : null;
		if (!pattern) return;
		const timer = setTimeout(() => navigator.vibrate(pattern), delay * 1000);
		return () => clearTimeout(timer);
	}, []); // eslint-disable-line react-hooks/exhaustive-deps
}

export function ResultPanel({ result, chips }: { result: RoundResult; chips: number }) {
	const won = result.net > 0;
	const push = result.net === 0;
	const tone = push ? 'push' : won ? 'win' : 'loss';
	const delay = revealSeconds(result);
	useVerdictBuzz(result, chips, delay);
	const revealed = useRevealed(delay);

	return (
		<div className="panel panel--table result">
			{/* The board goes first so the reveal is watched, not spoiled by the verdict. */}
			{result.view ? (
				<div className="board--static">
					<GameBoard view={result.view} busy={false} onAction={() => {}} animate stake={result.bet} />
				</div>
			) : null}
			{revealed ? (
				<div className={`reveal${result.view ? ' result__verdict' : ''}`}>
					<p className={`result__headline result__headline--${tone} result__headline--pop`}>
						{push ? 'PUSH' : won ? 'WIN' : 'LOSS'}
					</p>
					<p className={`delta delta--${tone}`} style={{ margin: '0.2rem 0' }}>
						{formatDelta(result.net)}
					</p>
					<p className="result__detail">
						{/* The poker games' recorded bet is the ante; their raises ride on top. */}
						{titleFor(result.game)} · {formatChips(result.bet)}{' '}
						{result.game === 'craps' ? 'line bet' : result.game === 'threecard' || result.game === 'ultimate' ? 'ante' : 'staked'}
						{result.doubled ? ' · doubled' : ''}
					</p>
					<p className="result__detail">{result.detail}</p>
				</div>
			) : null}
		</div>
	);
}
