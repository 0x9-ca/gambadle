/**
 * Wager selection, one picker per game.
 *
 * The engine has already chosen the game and taken the stake by the time the
 * client gets here (phase `choosing`), so these pickers only choose *how* to
 * wager that stake. Three card poker's ante is not adjustable — the stake is
 * already committed — so it only offers the Pair Plus side bet; Ultimate Texas
 * Hold'em likewise offers Trips, and blackjack the TriLux side bet.
 */

import {
	BACCARAT_ODDS,
	DICE_MAX_TARGET,
	DICE_MIN_TARGET,
	ROULETTE_MAX,
	SLOT_PAYTABLE,
	SLOT_SYMBOLS,
	SLOT_GLYPH,
	TCP_ANTE_BONUS,
	TCP_PAIR_PLUS,
	TCP_RANKS,
	TRILUX_LABEL,
	TRILUX_PAYS,
	UTH_BLIND,
	UTH_HANDS,
	UTH_MAX_ANTES,
	UTH_TRIPS,
	colorOf,
	rollUnderMultiplier,
	rollUnderWays,
} from '../../shared/games';
import { useState } from 'react';
import type { GameId, RouletteBet, RouletteChip, Wager } from '../../shared/protocol';
import { formatChips } from '../lib/format';
import { NumberField } from './NumberField';

interface Props {
	game: GameId;
	wager: Wager;
	/** Current stack, used to bound the Pair Plus slider. */
	stack: number;
	/** The committed stake. */
	bet: number;
	onChange: (wager: Wager) => void;
}

export function WagerPicker({ game, wager, stack, bet, onChange }: Props) {
	switch (game) {
		case 'roulette':
			return <RoulettePicker wager={wager} limit={bet} onChange={onChange} />;
		case 'baccarat':
			return <BaccaratPicker wager={wager} stack={stack} bet={bet} onChange={onChange} />;
		case 'coinflip':
			return <CoinFlipPicker wager={wager} onChange={onChange} />;
		case 'dice':
			return <DicePicker wager={wager} onChange={onChange} />;
		case 'threecard':
			return <ThreeCardPicker wager={wager} stack={stack} bet={bet} onChange={onChange} />;
		case 'blackjack':
			return <BlackjackPicker wager={wager} stack={stack} bet={bet} onChange={onChange} />;
		case 'ultimate':
			return <UltimatePicker wager={wager} stack={stack} bet={bet} onChange={onChange} />;
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------

const sameSpot = (a: RouletteBet, b: RouletteBet): boolean => JSON.stringify(a) === JSON.stringify(b);

const spotLabel = (bet: RouletteBet): string => {
	switch (bet.kind) {
		case 'straight':
			return `Straight up ${bet.number}`;
		case 'dozen':
			return `${bet.dozen === 1 ? '1st' : bet.dozen === 2 ? '2nd' : '3rd'} 12`;
		case 'column':
			// Name the column by its numbers, since "column 1" alone is ambiguous.
			return `Column ${bet.column} (${bet.column}, ${bet.column + 3} … ${bet.column + 33})`;
		case 'low':
			return '1–18';
		case 'high':
			return '19–36';
		default:
			return bet.kind[0]!.toUpperCase() + bet.kind.slice(1);
	}
};

/**
 * Chips on any number of spots. Pick a chip size (or type your own), then tap a
 * spot to put that many chips on it; tapping again adds more. Spots can be
 * removed individually, and the stake is whatever ends up on the table.
 */
function RoulettePicker({
	wager,
	limit,
	onChange,
}: {
	wager: Wager;
	/** The most that may be placed in total. */
	limit: number;
	onChange: (w: Wager) => void;
}) {
	const [chipSize, setChipSize] = useState(Math.min(10, limit));
	if (wager.game !== 'roulette') return null;
	const chips = wager.bets;
	const total = chips.reduce((sum, c) => sum + c.amount, 0);
	const remaining = Math.max(0, limit - total);
	const set = (bets: RouletteChip[]) => onChange({ game: 'roulette', bets });
	const amountOn = (bet: RouletteBet) => chips.find((c) => sameSpot(c.bet, bet))?.amount ?? 0;

	// A tap adds the chip size, or whatever is left if that is less.
	const place = (bet: RouletteBet) => {
		const add = Math.min(Math.max(1, chipSize), remaining);
		if (add < 1) return;
		const exists = chips.some((c) => sameSpot(c.bet, bet));
		set(
			exists
				? chips.map((c) => (sameSpot(c.bet, bet) ? { ...c, amount: c.amount + add } : c))
				: [...chips, { bet, amount: add }]
		);
	};
	const remove = (bet: RouletteBet) => set(chips.filter((c) => !sameSpot(c.bet, bet)));

	const quick = [...new Set([1, 5, 10, 25, 100].filter((v) => v <= limit))];

	const EVEN_MONEY = [
		{ kind: 'red', label: 'Red' },
		{ kind: 'black', label: 'Black' },
		{ kind: 'odd', label: 'Odd' },
		{ kind: 'even', label: 'Even' },
		{ kind: 'low', label: '1–18' },
		{ kind: 'high', label: '19–36' },
	] as const;

	const stake = (bet: RouletteBet) => {
		const amount = amountOn(bet);
		return amount > 0 ? <span className="choice__odds">{amount} on</span> : null;
	};

	return (
		<div className="wager">
			<p className="board__label" style={{ marginBottom: '0.35rem' }}>
				Chip size
			</p>
			<div className="quick-bets">
				{quick.map((value) => (
					<button
						key={value}
						type="button"
						className={`btn${chipSize === value ? ' btn--primary' : ' btn--ghost'}`}
						onClick={() => setChipSize(value)}
					>
						{value}
					</button>
				))}
				<NumberField
					className="chip-input"
					min={1}
					max={limit}
					value={chipSize}
					label="Custom chip size"
					onChange={setChipSize}
				/>
			</div>
			<p className="faint" style={{ margin: '0.4rem 0 0.6rem' }}>
				{formatChips(total)} placed · {formatChips(remaining)} left to place
			</p>

			<div className="choice-grid choice-grid--3">
				{EVEN_MONEY.map((option) => (
					<button
						key={option.kind}
						type="button"
						disabled={remaining < 1}
						className={`choice${amountOn({ kind: option.kind }) > 0 ? ' choice--on' : ''}`}
						onClick={() => place({ kind: option.kind })}
					>
						{option.label}
						<span className="choice__odds">1:1</span>
						{stake({ kind: option.kind })}
					</button>
				))}
			</div>

			<div className="choice-grid choice-grid--3" style={{ marginTop: '0.5rem' }}>
				{([1, 2, 3] as const).map((dozen) => (
					<button
						key={dozen}
						type="button"
						disabled={remaining < 1}
						className={`choice${amountOn({ kind: 'dozen', dozen }) > 0 ? ' choice--on' : ''}`}
						onClick={() => place({ kind: 'dozen', dozen })}
					>
						{dozen === 1 ? '1st' : dozen === 2 ? '2nd' : '3rd'} 12
						<span className="choice__odds">2:1</span>
						{stake({ kind: 'dozen', dozen })}
					</button>
				))}
			</div>

			<p className="faint" style={{ margin: '0.9rem 0 0.4rem' }}>
				Straight up 35:1 · columns 2 to 1
			</p>
			{/* Laid out like the table: 0 down the left across all three rows,
			    3-6-9…36 along the top, 1-4-7…34 along the bottom, and each row's
			    column bet at its end. */}
			<div className="roulette-grid">
				{Array.from({ length: ROULETTE_MAX + 1 }, (_, n) => {
					const amount = amountOn({ kind: 'straight', number: n });
					// Number n sits in table column ceil(n/3), row 3 - ((n-1) % 3).
					const position =
						n === 0
							? { gridColumn: 1, gridRow: '1 / span 3' }
							: { gridColumn: Math.ceil(n / 3) + 1, gridRow: 3 - ((n - 1) % 3) };
					return (
						<button
							key={n}
							type="button"
							aria-label={`Bet on ${n}`}
							disabled={remaining < 1}
							style={position}
							className={[
								'roulette-cell',
								`roulette-cell--${colorOf(n)}`,
								amount > 0 ? 'roulette-cell--on' : '',
							]
								.filter(Boolean)
								.join(' ')}
							onClick={() => place({ kind: 'straight', number: n })}
						>
							{n}
							{amount > 0 ? <span className="roulette-cell__chips">{amount}</span> : null}
						</button>
					);
				})}
				{([3, 2, 1] as const).map((column, row) => {
					const amount = amountOn({ kind: 'column', column });
					return (
						<button
							key={column}
							type="button"
							aria-label={`Bet on column ${column}, pays 2 to 1`}
							disabled={remaining < 1}
							style={{ gridColumn: 14, gridRow: row + 1 }}
							className={`roulette-cell roulette-cell--column${amount > 0 ? ' roulette-cell--on' : ''}`}
							onClick={() => place({ kind: 'column', column })}
						>
							2:1
							{amount > 0 ? <span className="roulette-cell__chips">{amount}</span> : null}
						</button>
					);
				})}
			</div>

			{chips.length > 0 ? (
				<div className="log" style={{ marginTop: '0.9rem' }}>
					{chips.map((chip) => (
						<div className="log__row spot-row" key={JSON.stringify(chip.bet)}>
							<span className="log__game">{spotLabel(chip.bet)}</span>
							<span className="log__delta">{formatChips(chip.amount)}</span>
							<button
								type="button"
								className="btn btn--ghost"
								aria-label={`Remove bet on ${spotLabel(chip.bet)}`}
								onClick={() => remove(chip.bet)}
							>
								✕
							</button>
						</div>
					))}
					<button type="button" className="btn btn--ghost btn--block" onClick={() => set([])}>
						Clear all
					</button>
				</div>
			) : (
				<p className="faint">Tap any spot to place chips.</p>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------

function BaccaratPicker({
	wager,
	stack,
	bet,
	onChange,
}: {
	wager: Wager;
	stack: number;
	bet: number;
	onChange: (w: Wager) => void;
}) {
	if (wager.game !== 'baccarat') return null;
	const main = wager.bet;
	// The side bet is sized separately, from whatever the stack has left after
	// the main bet. With nothing left it is not offered at all.
	const maxPair = Math.max(0, stack - bet);
	const canPair = maxPair >= 1;
	const pairAmount = main.pair === undefined ? 0 : Math.min(main.pairAmount ?? bet, maxPair);

	return (
		<div className="wager">
			<p className="board__label" style={{ marginBottom: '0.35rem' }}>
				Main bet — {bet}
			</p>
			<div className="choice-grid choice-grid--3">
				{(
					[
						{ main: 'player', label: 'Player', odds: `${BACCARAT_ODDS.player}:1` },
						{ main: 'banker', label: 'Banker', odds: `${BACCARAT_ODDS.banker}:1 less 5%` },
						{ main: 'tie', label: 'Tie', odds: `${BACCARAT_ODDS.tie}:1` },
					] as const
				).map((option) => (
					<button
						key={option.main}
						type="button"
						className={`choice${main.main === option.main ? ' choice--on' : ''}`}
						onClick={() => onChange({ game: 'baccarat', bet: { ...main, main: option.main } })}
					>
						{option.label}
						<span className="choice__odds">{option.odds}</span>
					</button>
				))}
			</div>

			<p className="board__label" style={{ margin: '0.9rem 0 0.35rem' }}>
				Pair side bet (optional){main.pair ? ` — ${pairAmount}` : ''}
			</p>
			<div className="choice-grid choice-grid--4">
				{(
					[
						{ pair: 'player', label: 'P pair', odds: `${BACCARAT_ODDS.playerPair}:1` },
						{ pair: 'banker', label: 'B pair', odds: `${BACCARAT_ODDS.bankerPair}:1` },
						{ pair: 'either', label: 'Either', odds: `${BACCARAT_ODDS.eitherPair}:1` },
					] as const
				).map((option) => (
					<button
						key={option.pair}
						type="button"
						disabled={!canPair}
						className={`choice${main.pair === option.pair ? ' choice--on' : ''}`}
						onClick={() => {
							const next = { ...main };
							if (main.pair === option.pair) {
								delete next.pair;
								delete next.pairAmount;
							} else {
								next.pair = option.pair;
								next.pairAmount = Math.min(main.pairAmount ?? bet, maxPair);
							}
							onChange({ game: 'baccarat', bet: next });
						}}
					>
						{option.label}
						<span className="choice__odds">{option.odds}</span>
					</button>
				))}
			</div>
			{main.pair ? (
				<div className="slider-row">
					<span className="faint">1</span>
					<input
						type="range"
						min={1}
						max={maxPair}
						step={1}
						value={pairAmount}
						onChange={(event) =>
							onChange({
								game: 'baccarat',
								bet: { ...main, pairAmount: Number(event.target.value) },
							})
						}
					/>
					<span className="faint">{maxPair}</span>
					<NumberField
						min={1}
						max={maxPair}
						value={pairAmount}
						label="Pair side bet chips"
						onChange={(value) => onChange({ game: 'baccarat', bet: { ...main, pairAmount: value } })}
					/>
				</div>
			) : null}
			{!canPair && (
				<p className="faint">Your stack has nothing left over for a side bet after the main bet.</p>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------

function CoinFlipPicker({ wager, onChange }: { wager: Wager; onChange: (w: Wager) => void }) {
	if (wager.game !== 'coinflip') return null;
	return (
		<div className="choice-grid choice-grid--2">
			{(['heads', 'tails'] as const).map((side) => (
				<button
					key={side}
					type="button"
					className={`choice${wager.bet.side === side ? ' choice--on' : ''}`}
					onClick={() => onChange({ game: 'coinflip', bet: { side } })}
				>
					{side === 'heads' ? 'Heads' : 'Tails'}
					<span className="choice__odds">1:1</span>
				</button>
			))}
		</div>
	);
}

// ---------------------------------------------------------------------------

function DicePicker({ wager, onChange }: { wager: Wager; onChange: (w: Wager) => void }) {
	if (wager.game !== 'dice') return null;
	const { target } = wager.bet;
	const multiplier = rollUnderMultiplier(target);

	return (
		<div className="wager">
			<p className="board__label" style={{ marginBottom: '0.35rem' }}>
				Roll under — {target}
			</p>
			<div className="slider-row">
				<span className="faint">{DICE_MIN_TARGET}</span>
				<input
					type="range"
					min={DICE_MIN_TARGET}
					max={DICE_MAX_TARGET}
					value={target}
					onChange={(event) =>
						onChange({
							game: 'dice',
							bet: { kind: 'roll_under', target: Number(event.target.value) },
						})
					}
				/>
				<span className="faint">{DICE_MAX_TARGET}</span>
				<span className="slider-value">{target}</span>
			</div>
			<p className="faint" style={{ margin: '0.6rem 0 0' }}>
				{rollUnderWays(target)} of 36 rolls of two dice win — {+(multiplier - 1).toFixed(2)}:1, or {multiplier}× your bet back.
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------

function ThreeCardPicker({
	wager,
	stack,
	bet,
	onChange,
}: {
	wager: Wager;
	stack: number;
	bet: number;
	onChange: (w: Wager) => void;
}) {
	if (wager.game !== 'threecard') return null;
	const pairPlus = wager.bet.pairPlus ?? 0;
	// The ante and its matching play bet are already committed.
	const maxPairPlus = Math.max(0, stack - bet * 2);

	const setPairPlus = (value: number) => {
		const next: Wager = { game: 'threecard', bet: { ante: bet } };
		if (value > 0) next.bet.pairPlus = value;
		onChange(next);
	};

	return (
		<div className="wager">
			<div className="panel" style={{ background: 'var(--surface-2)', padding: '0.7rem 0.85rem' }}>
				<div className="total-row">
					<span className="board__label">Ante</span>
					<span className="board__total">{bet}</span>
				</div>
				<div className="total-row">
					<span className="board__label">Play bet</span>
					<span className="board__total">{bet}</span>
				</div>
				<div className="total-row">
					<span className="board__label">At risk if you play</span>
					<span className="board__total">{bet * 2 + pairPlus}</span>
				</div>
				<p className="faint" style={{ margin: '0.5rem 0 0' }}>
					Dealer qualifies with queen-high. Folding surrenders just the ante.
				</p>
			</div>

			<SideBetSlider label="Pair Plus" value={pairPlus} max={maxPairPlus} onChange={setPairPlus} />

			<details className="paytable">
				<summary>Paytables</summary>
				<table>
					<thead>
						<tr>
							<th scope="col">Hand</th>
							<th scope="col">Pair Plus</th>
							<th scope="col">Ante Bonus</th>
						</tr>
					</thead>
					<tbody>
						{TCP_RANKS.map((rank) => (
							<tr key={rank}>
								<th scope="row">{rank}</th>
								<td>{TCP_PAIR_PLUS[rank] < 0 ? 'loses' : `${TCP_PAIR_PLUS[rank]}:1`}</td>
								<td>{TCP_ANTE_BONUS[rank] ? `${TCP_ANTE_BONUS[rank]}:1` : '—'}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="faint">Ante Bonus pays whatever the dealer holds. If the dealer does not qualify, the ante pays 1:1 and the Play bet pushes.</p>
			</details>
		</div>
	);
}

// ---------------------------------------------------------------------------

/** An optional side bet, sized by slider or typed, from 0 (off) to `max`. */
function SideBetSlider({
	label,
	value,
	max,
	onChange,
}: {
	label: string;
	value: number;
	max: number;
	onChange: (value: number) => void;
}) {
	return (
		<>
			<p className="board__label" style={{ margin: '0.9rem 0 0.35rem' }}>
				{label} (optional)
			</p>
			<div className="slider-row">
				<button
					type="button"
					className="choice"
					style={{ flex: 'none', paddingInline: '0.8rem' }}
					onClick={() => onChange(0)}
					disabled={value === 0}
				>
					Off
				</button>
				<input
					type="range"
					min={0}
					max={max}
					step={1}
					aria-label={`${label} chips`}
					value={Math.min(value, max)}
					onChange={(event) => onChange(Number(event.target.value))}
					disabled={max === 0}
				/>
				<NumberField min={0} max={max} value={value} label={`${label} chips`} onChange={onChange} disabled={max === 0} />
			</div>
			{max === 0 ? <p className="faint">Your stack has nothing left over for a side bet.</p> : null}
		</>
	);
}

function BlackjackPicker({
	wager,
	stack,
	bet,
	onChange,
}: {
	wager: Wager;
	stack: number;
	bet: number;
	onChange: (w: Wager) => void;
}) {
	if (wager.game !== 'blackjack') return null;
	const trilux = wager.trilux ?? 0;
	const max = Math.max(0, stack - bet);
	const rows = (['royal flush', 'straight flush', 'three of a kind', 'straight', 'flush'] as const).filter(
		(rank) => TRILUX_PAYS[rank] !== undefined
	);
	return (
		<div className="wager">
			<p className="faint" style={{ margin: 0 }}>
				TriLux pays on the poker hand made by your first two cards and the dealer's up card.
			</p>
			<SideBetSlider
				label="TriLux"
				value={trilux}
				max={max}
				onChange={(value) => onChange(value > 0 ? { game: 'blackjack', trilux: value } : { game: 'blackjack' })}
			/>
			<details className="paytable">
				<summary>TriLux paytable</summary>
				<ul className="paytable__list">
					{rows.map((rank) => (
						<li key={rank}>
							<span>{TRILUX_LABEL[rank]}{rank === 'royal flush' ? ' (A-K-Q suited)' : ''}</span>
							<span className="faint">{TRILUX_PAYS[rank]}:1</span>
						</li>
					))}
				</ul>
				<p className="faint">Settled on the deal, whatever happens to the hand. Anything else loses.</p>
			</details>
		</div>
	);
}

const odds = (n: number) => (n === 1.5 ? '3:2' : `${n}:1`);

function UltimatePicker({
	wager,
	stack,
	bet,
	onChange,
}: {
	wager: Wager;
	stack: number;
	bet: number;
	onChange: (w: Wager) => void;
}) {
	if (wager.game !== 'ultimate') return null;
	const trips = wager.bet.trips ?? 0;
	// Ante, Blind and room for a 4x raise are already set aside.
	const max = Math.max(0, stack - bet * UTH_MAX_ANTES);
	return (
		<div className="wager">
			<div className="panel" style={{ background: 'var(--surface-2)', padding: '0.7rem 0.85rem' }}>
				<div className="total-row">
					<span className="board__label">Ante</span>
					<span className="board__total">{bet}</span>
				</div>
				<div className="total-row">
					<span className="board__label">Blind</span>
					<span className="board__total">{bet}</span>
				</div>
				<div className="total-row">
					<span className="board__label">Most at risk (4x raise)</span>
					<span className="board__total">{bet * UTH_MAX_ANTES + trips}</span>
				</div>
				<p className="faint" style={{ margin: '0.5rem 0 0' }}>
					Raise 4x or 3x before the flop, 2x on the flop, or 1x on the river (else fold). The dealer
					needs a pair to qualify; if not, your ante pushes.
				</p>
			</div>
			<SideBetSlider
				label="Trips"
				value={trips}
				max={max}
				onChange={(value) =>
					onChange({ game: 'ultimate', bet: value > 0 ? { ante: bet, trips: value } : { ante: bet } })
				}
			/>
			<details className="paytable">
				<summary>Paytables</summary>
				<table>
					<thead>
						<tr>
							<th scope="col">Hand</th>
							<th scope="col">Blind</th>
							<th scope="col">Trips</th>
						</tr>
					</thead>
					<tbody>
						{UTH_HANDS.map((hand) => (
							<tr key={hand}>
								<th scope="row">{hand}</th>
								<td>{UTH_BLIND[hand] !== undefined ? odds(UTH_BLIND[hand]) : 'push'}</td>
								<td>{odds(UTH_TRIPS[hand])}</td>
							</tr>
						))}
					</tbody>
				</table>
				<p className="faint">
					The Blind pays only when you win; a winning hand below a straight pushes it. Trips pays on your
					hand whatever the dealer holds, even if you fold.
				</p>
			</details>
		</div>
	);
}

// ---------------------------------------------------------------------------

/** Shown on the slot board: what three of a kind pays. */
export function SlotsPaytable() {
	// Richest first, so the jackpot is the first thing anyone reads.
	const rows = [...SLOT_SYMBOLS].sort((a, b) => SLOT_PAYTABLE[b] - SLOT_PAYTABLE[a]);
	return (
		<details className="paytable">
			<summary>Paytable</summary>
			<ul className="paytable__list">
				{rows.map((symbol) => (
					<li key={symbol}>
						<span>
							{SLOT_GLYPH[symbol]} {symbol}
						</span>
						{/* The table holds return multiples; the odds people quote are profit. */}
						<span className="faint">{SLOT_PAYTABLE[symbol] - 1}:1</span>
					</li>
				))}
			</ul>
			<p className="faint">
				Three paylines: top, middle and bottom. Any line showing three of a kind
				pays the full amount, so two winning lines pay twice over. Returns about
				90% of every chip staked.
			</p>
		</details>
	);
}