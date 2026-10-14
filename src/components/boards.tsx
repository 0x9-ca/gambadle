/**
 * Game boards — one per game, each rendering the `GameView` the Worker sent.
 *
 * Pure display. They never decide an outcome and never hold a value the server
 * did not send; buttons only name the action to send back. Whether the round is
 * over comes from `view.resolved`, which the server sets — never inferred here.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { colorOf, SLOT_LINES, SLOT_SYMBOLS } from '../../shared/games';
import type { Action, CardView, GameId, GameView, HandView, PaiGowSplit } from '../../shared/protocol';
import { Hand, PlayingCard } from './PlayingCard';
import { SlotIcon } from './SlotIcon';
import { SlotsPaytable } from './wagers';

interface BoardProps {
	/** True while an action is in flight. */
	busy: boolean;
	onAction: (action: Action) => void;
	/**
	 * Set on the result screen, where the finished board plays out the reveal
	 * (dice tumbling, reels stopping, a hole card turning over). Purely
	 * cosmetic: the outcome is already in the view the server sent.
	 */
	animate?: boolean;
}

const prefersReducedMotion = (): boolean =>
	typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** True for `ms` after mount when `enabled`, never under reduced motion. */
function useRollOnMount(enabled: boolean, ms: number): boolean {
	const [rolling, setRolling] = useState(() => enabled && !prefersReducedMotion());
	useEffect(() => {
		if (!rolling) return;
		const timer = setTimeout(() => setRolling(false), ms);
		return () => clearTimeout(timer);
	}, []); // eslint-disable-line react-hooks/exhaustive-deps
	return rolling;
}

/**
 * A counter that advances while `active`, to cycle placeholder faces. The
 * placeholders come from a fixed stride over it, not a random source: they are
 * decoration only and the real result is whatever the server sent.
 */
function useTick(active: boolean, ms = 90): number {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setTick((t) => t + 1), ms);
		return () => clearInterval(timer);
	}, [active, ms]);
	return tick;
}

/** A board narrowed to one game. */
type BoardOf<G extends GameId> = BoardProps & { view: Extract<GameView, { game: G }> };

export function GameBoard(props: BoardProps & { view: GameView }) {
	switch (props.view.game) {
		case 'blackjack':
			return <BlackjackBoard {...props} view={props.view} />;
		case 'roulette':
			return <RouletteBoard {...props} view={props.view} />;
		case 'baccarat':
			return <BaccaratBoard {...props} view={props.view} />;
		case 'coinflip':
			return <CoinFlipBoard {...props} view={props.view} />;
		case 'dice':
			return <DiceBoard {...props} view={props.view} />;
		case 'slots':
			return <SlotsBoard {...props} view={props.view} />;
		case 'threecard':
			return <ThreeCardBoard {...props} view={props.view} />;
		case 'ultimate':
			return <UltimateBoard {...props} view={props.view} />;
		case 'paigow':
			return <PaiGowBoard {...props} view={props.view} />;
	}
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function Total({ hand }: { hand: HandView }) {
	return (
		<>
			{hand.total}
			{hand.isSoft ? <span className="board__total--soft"> soft</span> : null}
		</>
	);
}

function BoardRow({
	label,
	hand,
	showTotal = true,
	active = false,
	still,
	flip,
}: {
	still?: number;
	flip?: number;
	label: string;
	hand: HandView;
	/** Games whose hands are not scored by a running total hide it. */
	showTotal?: boolean;
	active?: boolean;
}) {
	return (
		<div className={`board__row${active ? ' board__row--active' : ''}`}>
			<span className="board__label">{label}</span>
			<Hand cards={hand.cards} hideLast={hand.hidden === true} still={still} flip={flip} />
			{/* Poker hands have no running total, so they leave the column out. */}
			{showTotal ? (
				<span className="board__total">
					{hand.hidden ? '—' : <Total hand={hand} />}
					{hand.doubled ? <span className="faint"> ×2</span> : null}
				</span>
			) : null}
		</div>
	);
}

function Actions({ children }: { children: ReactNode }) {
	return <div className="btn-row">{children}</div>;
}

function Note({ children }: { children: ReactNode }) {
	return (
		<p className="faint" style={{ margin: 0 }}>
			{children}
		</p>
	);
}

// ---------------------------------------------------------------------------
// Blackjack
// ---------------------------------------------------------------------------

function BlackjackBoard({ view, busy, onAction, animate }: BoardOf<'blackjack'>) {
	const split = view.hands.length > 1;
	const button = (type: 'HIT' | 'STAND' | 'DOUBLE' | 'SPLIT' | 'INSURE' | 'NO_INSURANCE', label: string, primary = false) => (
		<button
			type="button"
			className={`btn${primary ? ' btn--primary' : ''}`}
			disabled={busy}
			onClick={() => onAction({ type })}
		>
			{label}
		</button>
	);

	return (
		<div className="board">
			{/* On the result screen the dealer's up card stays put and the hole card turns over. */}
			<BoardRow
				label="Dealer"
				hand={view.dealer}
				still={animate && !view.opening ? 1 : undefined}
				flip={animate ? 1 : undefined}
			/>
			{view.hands.map((hand, index) => (
				<BoardRow
					key={index}
					label={split ? `Hand ${index + 1}` : 'You'}
					hand={hand}
					active={split && !view.resolved && index === view.active}
					// A round that ended on the deal was never seen in play, so deal it out.
					still={animate && !view.opening ? hand.cards.length : undefined}
				/>
			))}
			<Note>Blackjack pays 3:2. Dealer stands on all 17s.</Note>
			{view.trilux ? (
				<Note>
					TriLux ({view.trilux.bet}):{' '}
					{view.trilux.hand ? `${view.trilux.hand} pays ${view.trilux.pays}:1` : 'no hand, lost'}
				</Note>
			) : null}
			{!view.resolved && view.insured > 0 ? <Note>Insured for {view.insured}.</Note> : null}
			{!view.resolved && view.insuranceOffer !== null ? (
				<>
					<Note>Dealer shows an ace. Insurance pays 2:1 if the dealer has blackjack.</Note>
					<Actions>
						{button('INSURE', `Insure (${view.insuranceOffer})`, true)}
						{button('NO_INSURANCE', 'No insurance')}
					</Actions>
				</>
			) : !view.resolved ? (
				<Actions>
					{button('HIT', 'Hit', true)}
					{button('STAND', 'Stand')}
					{view.canDouble ? button('DOUBLE', 'Double') : null}
					{view.canSplit ? button('SPLIT', 'Split') : null}
				</Actions>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Roulette
// ---------------------------------------------------------------------------

/** Pocket order on a European wheel, clockwise from zero. */
const WHEEL_ORDER = [
	0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29,
	7, 28, 12, 35, 3, 26,
];
const POCKET_DEG = 360 / WHEEL_ORDER.length;
/** Rotor run-down and ball run-down on the result screen; the ball drops before the rotor stops. */
const ROTOR_MS = 3000;
const BALL_MS = 2300;

/** One pocket's wedge, in a 200×200 viewBox centred on (100, 100). */
function pocketPath(index: number, outer: number, inner: number): string {
	const a0 = ((index - 0.5) * POCKET_DEG - 90) * (Math.PI / 180);
	const a1 = ((index + 0.5) * POCKET_DEG - 90) * (Math.PI / 180);
	const pt = (r: number, a: number) => `${(100 + r * Math.cos(a)).toFixed(2)} ${(100 + r * Math.sin(a)).toFixed(2)}`;
	return `M${pt(outer, a0)} A${outer} ${outer} 0 0 1 ${pt(outer, a1)} L${pt(inner, a1)} A${inner} ${inner} 0 0 0 ${pt(inner, a0)} Z`;
}

/** The static wheel face; it never changes, so it is drawn once. */
const WHEEL_FACE = (
	<svg className="wheel__face" viewBox="0 0 200 200" aria-hidden="true">
		<circle cx="100" cy="100" r="99" className="wheel__rim" />
		<circle cx="100" cy="100" r="90" className="wheel__track" />
		{WHEEL_ORDER.map((n, i) => (
			<g key={n}>
				<path d={pocketPath(i, 80, 54)} className={`wheel__pocket wheel__pocket--${colorOf(n)}`} />
				<text
					x="100"
					y="32"
					className="wheel__num"
					transform={`rotate(${i * POCKET_DEG} 100 100)`}
				>
					{n}
				</text>
			</g>
		))}
		<circle cx="100" cy="100" r="54" className="wheel__cone" />
		<circle cx="100" cy="100" r="16" className="wheel__hub" />
	</svg>
);

function RouletteBoard({ view, busy, onAction, animate }: BoardOf<'roulette'>) {
	const rolling = useRollOnMount(!!animate && view.resolved, ROTOR_MS);
	const spinning = busy && !view.resolved;
	// Rest positions: the rotor ends a turn and a half on, and the ball, which
	// rides the rotor, ends in the pocket of the number the server sent.
	const rotorEnd = 540;
	const ballEnd = WHEEL_ORDER.indexOf(view.number) * POCKET_DEG - 360 * 5;
	// No ball on a wheel that has not been spun yet, nor before it starts turning.
	const showBall = spinning || view.resolved;
	const phase = spinning ? 'spin' : rolling ? 'settle' : view.resolved ? 'rest' : 'idle';
	const done = view.resolved && !rolling;
	return (
		<div className="board">
			<div className={`wheel wheel--${phase}`}>
				<div
					className="wheel__rotor"
					style={
						phase === 'settle' || phase === 'rest'
							? { transform: `rotate(${rotorEnd}deg)`, animationDuration: `${ROTOR_MS}ms` }
							: undefined
					}
				>
					{WHEEL_FACE}
					{showBall ? (
						<div
							className="wheel__arm"
							style={
								phase === 'settle' || phase === 'rest'
									? { transform: `rotate(${ballEnd}deg)`, animationDuration: `${BALL_MS}ms` }
									: undefined
							}
						>
							<div className="wheel__ball" style={{ animationDuration: phase === 'settle' ? `${BALL_MS}ms` : undefined }} />
						</div>
					) : null}
				</div>
			</div>
			<div className="wheel__result">
				{done ? (
					<>
						<div className={`wheel-ball wheel-ball--${view.color}`}>{view.number}</div>
						<p className="result__detail" style={{ margin: 0 }}>
							{view.color === 'green' ? 'Green' : view.color === 'red' ? 'Red' : 'Black'}
						</p>
					</>
				) : (
					<p className="result__detail" style={{ margin: 0 }}>
						{spinning || rolling ? 'No more bets…' : 'Spin when ready.'}
					</p>
				)}
			</div>
			<Actions>
				<button
					type="button"
					className="btn btn--primary"
					disabled={busy || view.resolved}
					onClick={() => onAction({ type: 'SPIN' })}
				>
					{view.resolved ? 'No more bets' : 'Spin'}
				</button>
			</Actions>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Baccarat
// ---------------------------------------------------------------------------

function BaccaratBoard({ view, busy, onAction, animate }: BoardOf<'baccarat'>) {
	return (
		<div className="board">
			{/* The opening two cards were seen before Deal; only third cards are new. */}
			<BoardRow label="Player" hand={view.player} still={animate ? 2 : undefined} />
			<BoardRow label="Banker" hand={view.banker} still={animate ? 2 : undefined} />
			{view.playerPair || view.bankerPair ? (
				<Note>
					{view.playerPair && view.bankerPair
						? 'Both sides hold a pair'
						: view.playerPair
							? 'Player pair'
							: 'Banker pair'}
				</Note>
			) : null}
			<Actions>
				<button
					type="button"
					className="btn btn--primary"
					disabled={busy || view.resolved}
					onClick={() => onAction({ type: 'DEAL' })}
				>
					{view.resolved ? 'Hand complete' : 'Deal'}
				</button>
			</Actions>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Coin flip
// ---------------------------------------------------------------------------

function CoinFlipBoard({ view, busy, onAction, animate }: BoardOf<'coinflip'>) {
	const rolling = useRollOnMount(!!animate && view.resolved, 900);
	const flipping = busy || rolling;
	return (
		<div className="board">
			{/* Drawn in CSS: emoji coins vary by platform and some fonts have none. */}
			<div className={`coin${flipping ? ' coin--flip' : ''}${settledSide(view.resolved && !flipping, view.result)}`} aria-hidden="true">
				<span className="coin__face">{view.resolved && !flipping ? (view.result === 'heads' ? 'H' : 'T') : '?'}</span>
			</div>
			<p className="board__caption">
				{view.resolved && !flipping ? (view.result === 'heads' ? 'Heads' : 'Tails') : flipping ? 'In the air…' : 'Call it, then flip'}
			</p>
			<Actions>
				<button
					type="button"
					className="btn btn--primary"
					disabled={busy || view.resolved}
					onClick={() => onAction({ type: 'FLIP' })}
				>
					{view.resolved ? 'Flipped' : 'Flip'}
				</button>
			</Actions>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Dice
// ---------------------------------------------------------------------------

/** Pip positions on a 3×3 grid, numbered 0-8 left to right, top to bottom. */
const PIPS: Record<number, number[]> = {
	1: [4],
	2: [2, 6],
	3: [2, 4, 6],
	4: [0, 2, 6, 8],
	5: [0, 2, 4, 6, 8],
	6: [0, 2, 3, 5, 6, 8],
};

function Die({ face, rolling, blank }: { face: number; rolling: boolean; blank?: boolean }) {
	return (
		<span className={`die${rolling ? ' die--rolling' : ''}${blank ? ' die--blank' : ''}`} role="img" aria-label={blank ? 'Die' : `Die showing ${face}`}>
			{Array.from({ length: 9 }, (_, i) => (
				<span key={i} className={PIPS[face]?.includes(i) ? 'die__pip' : 'die__slot'} />
			))}
		</span>
	);
}

/** Class for a landed coin, so heads and tails read differently at a glance. */
const settledSide = (settled: boolean, side: 'heads' | 'tails'): string => (settled ? ` coin--${side}` : '');

function DiceBoard({ view, busy, onAction, animate }: BoardOf<'dice'>) {
	const rolling = useRollOnMount(!!animate && view.resolved, 900);
	const tumbling = busy || rolling;
	const tick = useTick(tumbling, 80);
	// Placeholder faces while tumbling; the settled faces are the server's.
	const faces = tumbling ? [0, 1].map((i) => ((tick * 5 + i * 3) % 6) + 1) : view.dice;
	const settled = view.resolved && !tumbling;

	return (
		<div className="board">
			<div className="dice-row">
				{/* Unrolled dice show a five, the face that reads as "a die" best. */}
				{(faces.length === 0 ? [5, 5] : faces).map((face, i) => (
					<Die key={i} face={face} rolling={tumbling} blank={faces.length === 0} />
				))}
			</div>
			<p className="board__caption">
				{settled ? (
					<>
						Total <strong className="board__caption-value">{view.roll}</strong>
					</>
				) : tumbling ? (
					'Rolling…'
				) : (
					'Two six-sided dice'
				)}
			</p>
			<Actions>
				<button
					type="button"
					className="btn btn--primary"
					disabled={busy || view.resolved}
					onClick={() => onAction({ type: 'ROLL' })}
				>
					{view.resolved ? 'Rolled' : 'Roll'}
				</button>
			</Actions>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/** When each reel comes to rest on the result screen, in ms; left to right. */
const REEL_STOPS = [700, 1100, 1500];

function SlotsBoard({ view, busy, onAction, animate }: BoardOf<'slots'>) {
	const reduced = prefersReducedMotion();
	const [stopped, setStopped] = useState(() => (animate && view.resolved && !reduced ? 0 : REEL_STOPS.length));

	// Reels come to rest one after another, so the last one is the suspense.
	useEffect(() => {
		if (stopped >= REEL_STOPS.length) return;
		const timers = REEL_STOPS.map((ms, i) => setTimeout(() => setStopped(i + 1), ms));
		return () => timers.forEach(clearTimeout);
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	const spinningReel = (reel: number) => busy || reel >= stopped;
	const tick = useTick(busy || stopped < REEL_STOPS.length, 80);
	const done = !busy && stopped >= REEL_STOPS.length;

	return (
		<div className="board">
			<div className="reels">
				{view.reels.map((reel, reelIndex) => {
					const spinning = spinningReel(reelIndex);
					return (
						<div key={reelIndex} className={`reel${spinning ? ' reel--spinning' : ''}`}>
							{reel.map((symbolIndex, rowIndex) => {
								// Placeholder symbols while the reel runs; the stop is the server's.
								const shown = spinning
									? (tick * 7 + reelIndex * 5 + rowIndex * 3) % SLOT_SYMBOLS.length
									: symbolIndex;
								const symbol = SLOT_SYMBOLS[shown] ?? 'cherry';
								const isWin = view.resolved && done && view.lines.includes(rowIndex);
								return (
									<div key={rowIndex} className={`reel__cell${isWin ? ' reel__cell--win' : ''}`}>
										<SlotIcon symbol={symbol} size="2.1rem" />
									</div>
								);
							})}
						</div>
					);
				})}
			</div>

			{view.resolved && done ? (
				view.win > 0 ? (
					<p className="board__caption">
						{/* `win` is a return multiple of the whole stake, so profit is one less. */}
						{view.lines.map((row) => SLOT_LINES[row]).join(' and ')} line pays{' '}
						<strong className="board__caption-value">{view.win - 1}:1</strong>
					</p>
				) : (
					<p className="board__caption">No winning lines</p>
				)
			) : null}

			<Actions>
				<button
					type="button"
					className="btn btn--primary"
					disabled={busy || view.resolved}
					onClick={() => onAction({ type: 'SPIN' })}
				>
					{view.resolved ? 'Spun' : 'Spin'}
				</button>
			</Actions>

			<SlotsPaytable />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Three Card Poker
// ---------------------------------------------------------------------------

function ThreeCardBoard({ view, busy, onAction, animate }: BoardOf<'threecard'>) {
	return (
		<div className="board">
			<BoardRow
				label="Your hand"
				hand={view.hand}
				showTotal={false}
				still={animate ? view.hand.cards.length : undefined}
			/>
			<p className="board__label" style={{ margin: 0 }}>
				{view.rank}
			</p>
			{/* Dealt only once the player plays; a fold never shows the dealer. */}
			{view.dealer ? (
				<>
					<BoardRow label="Dealer" hand={view.dealer} showTotal={false} />
					<p className="board__label" style={{ margin: 0 }}>
						{view.dealerRank}
					</p>
				</>
			) : null}
			{view.resolved ? (
				view.dealerQualifies === false ? (
					<Note>Dealer does not qualify (needs queen high).</Note>
				) : null
			) : (
				<Actions>
					<button
						type="button"
						className="btn btn--danger"
						disabled={busy}
						onClick={() => onAction({ type: 'FOLD' })}
					>
						Fold
					</button>
					<button
						type="button"
						className="btn btn--win"
						disabled={busy}
						onClick={() => onAction({ type: 'PLAY' })}
					>
						Play
					</button>
				</Actions>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Ultimate Texas Hold'em
// ---------------------------------------------------------------------------

/** Placeholder faces for cards the player has not seen; drawn face down. */
const UNSEEN: CardView = { rank: 10, suit: 's' };

/** A row of cards where the first `shown` are face up and the rest face down. */
function CardsRow({
	label,
	cards,
	slots,
	still,
	note,
	stacked = false,
}: {
	label: string;
	cards: CardView[];
	/** Total positions, so unseen cards are drawn face down. */
	slots: number;
	still?: number;
	note?: string | null;
	/** Label and note above the cards, for rows too wide to share a line. */
	stacked?: boolean;
}) {
	if (stacked) {
		return (
			<div className="board__stack">
				<div className="board__row">
					<span className="board__label">{label}</span>
					{note ? <span className="board__label board__note">{note}</span> : null}
				</div>
				<div className="hand hand--compact">
					{cards.map((card, index) => (
						// eslint-disable-next-line react/no-array-index-key
						<PlayingCard key={index} card={card} motion={still !== undefined && index < still ? 'still' : 'deal'} />
					))}
				</div>
			</div>
		);
	}
	return (
		<div className="board__row">
			<span className="board__label">{label}</span>
			<div className="hand hand--compact">
				{Array.from({ length: slots }, (_, index) => {
					const card = cards[index];
					return (
						<PlayingCard
							// eslint-disable-next-line react/no-array-index-key
							key={index}
							card={card ?? UNSEEN}
							faceDown={!card}
							// Face-up cards deal in as they are revealed; on a result board only
							// the ones past `still` are new.
							motion={card && (still === undefined || index >= still) ? 'deal' : 'still'}
							delay={
								!card
									? 0
									: still !== undefined
										? Math.max(0, index - still) * 200
										: // Live play: the flop's three cards land one by one, as do the turn and river.
											(slots === 5 && index >= 3 ? index - 3 : index) * 150
							}
						/>
					);
				})}
			</div>
			{note !== undefined ? <span className="board__label board__note">{note}</span> : null}
		</div>
	);
}

function UltimateBoard({ view, busy, onAction, animate }: BoardOf<'ultimate'>) {
	const raise = (multiple: number) => (
		<button
			key={multiple}
			type="button"
			className="btn btn--win"
			disabled={busy}
			onClick={() => onAction({ type: `BET_${multiple}X` as 'BET_4X' })}
		>
			Bet {multiple}x
		</button>
	);
	return (
		<div className="board">
			<CardsRow
				label="Dealer"
				cards={view.dealer?.cards ?? []}
				slots={2}
				still={animate ? 0 : undefined}
				note={view.dealerRank}
			/>
			<CardsRow label="Board" cards={view.board.cards} slots={5} still={animate ? 5 : undefined} />
			<CardsRow label="You" cards={view.hand.cards} slots={2} still={animate ? 2 : undefined} />
			<p className="board__label" style={{ margin: 0 }}>
				{view.rank}
				{view.play > 0 ? ` · Play bet ${view.play}` : ''}
			</p>
			{view.resolved ? (
				view.folded ? (
					<Note>You folded.</Note>
				) : view.dealerQualifies === false ? (
					<Note>Dealer does not qualify (needs a pair); the ante pushes.</Note>
				) : null
			) : (
				<Actions>
					{view.stage === 'river' ? (
						<button
							type="button"
							className="btn btn--danger"
							disabled={busy}
							onClick={() => onAction({ type: 'FOLD' })}
						>
							Fold
						</button>
					) : (
						<button type="button" className="btn" disabled={busy} onClick={() => onAction({ type: 'CHECK' })}>
							Check
						</button>
					)}
					{view.raises.map(raise)}
				</Actions>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Pai Gow Poker
// ---------------------------------------------------------------------------

function SplitRows({ label, split, results }: { label: string; split: PaiGowSplit; results?: { high: 1 | -1; low: 1 | -1 } | null }) {
	const mark = (r: 1 | -1 | undefined) => (r === undefined ? '' : r === 1 ? ' ✓' : ' ✗');
	return (
		<>
			<CardsRow stacked label={`${label} high`} cards={split.high.cards} slots={5} note={`${split.highRank}${mark(results?.high)}`} />
			<CardsRow stacked label={`${label} low`} cards={split.low.cards} slots={2} note={`${split.lowRank}${mark(results?.low)}`} />
		</>
	);
}

function PaiGowBoard({ view, busy, onAction }: BoardOf<'paigow'>) {
	// Starts on the house way, so a player who just confirms plays it.
	const [low, setLow] = useState<number[]>(() => view.houseWay);
	const toggle = (index: number) =>
		setLow((current) =>
			current.includes(index)
				? current.filter((i) => i !== index)
				: current.length < 2
					? [...current, index]
					: [current[1]!, index]
		);

	// The server lists every legal split by name; the pick is looked up there.
	const picked =
		low.length === 2 ? view.splits.find((split) => split.low.includes(low[0]!) && split.low.includes(low[1]!)) : undefined;
	const foul = low.length === 2 && !picked;

	if (view.resolved && view.player && view.dealer) {
		return (
			<div className="board">
				<SplitRows label="Dealer" split={view.dealer} />
				<SplitRows label="Your" split={view.player} results={view.results} />
				<Note>Ties go to the dealer. Winning both hands pays 1:1 less 5%; one each is a push.</Note>
			</div>
		);
	}

	return (
		<div className="board">
			<p className="board__label" style={{ margin: 0 }}>
				Tap two cards for your low hand ({low.length}/2)
			</p>
			<div className="hand hand--compact pick-hand">
				{view.hand.cards.map((card, index) => (
					<button
						// eslint-disable-next-line react/no-array-index-key
						key={index}
						type="button"
						className={`card-pick${low.includes(index) ? ' card-pick--low' : ''}`}
						aria-pressed={low.includes(index)}
						disabled={busy}
						onClick={() => toggle(index)}
					>
						<PlayingCard card={card} motion="still" />
					</button>
				))}
			</div>
			<div className={`split-preview${foul ? ' split-preview--foul' : ''}`} aria-live="polite">
				{picked ? (
					<>
						<span>
							<span className="board__label">High</span> {picked.highRank}
						</span>
						<span>
							<span className="board__label">Low</span> {picked.lowRank}
						</span>
					</>
				) : foul ? (
					<span>Not allowed: the low hand would beat the high hand.</span>
				) : (
					<span className="faint">Pick {2 - low.length} more for the low hand.</span>
				)}
			</div>
			<Note>The five-card high hand must outrank the two-card low hand. The joker is an ace, or completes a straight or flush.</Note>
			<Actions>
				<button type="button" className="btn" disabled={busy} onClick={() => onAction({ type: 'HOUSE_WAY' })}>
					House way
				</button>
				<button
					type="button"
					className="btn btn--primary"
					disabled={busy || !picked}
					onClick={() => onAction({ type: 'SET_HAND', low })}
				>
					Set hand
				</button>
			</Actions>
		</div>
	);
}
