/**
 * The Mega Slots machine: a marquee, five spinning reels of five, the winning
 * lines traced over the window one at a time, a win meter that counts up, and
 * the free spins bonus played out spin by spin.
 *
 * Pure display, like every board. The server sends every spin of the round
 * (base and free) already settled; this only stages them over time. The
 * timeline lives in lib/megaTimeline so the reveal hold waits for the same end.
 */

import { useEffect, useMemo, useState } from 'react';
import {
	MEGA_FREE_MULTIPLIER,
	MEGA_FREE_SPINS,
	MEGA_LINES,
	MEGA_PAYS,
	MEGA_SCATTER_PAYS,
	MEGA_SYMBOLS,
	type MegaSymbol,
} from '../../shared/megaslots';
import type { Action, GameView, MegaSpinView } from '../../shared/protocol';
import { formatChips } from '../lib/format';
import { megaEnd, momentAt } from '../lib/megaTimeline';
import { MEGA_NAMES, MegaIcon } from './MegaIcon';

type MegaView = Extract<GameView, { game: 'megaslots' }>;

const reducedMotion = (): boolean =>
	typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** Line colours, cycled, so neighbouring lines read apart when traced. */
const LINE_COLORS = ['#facc15', '#22d3ee', '#f472b6', '#4ade80', '#fb923c', '#a78bfa', '#f87171', '#60a5fa'];

/** Milliseconds since mount while `running`, ticking at frame rate. */
function useClock(running: boolean): number {
	const [t, setT] = useState(0);
	useEffect(() => {
		if (!running) return;
		const start = performance.now();
		let frame = requestAnimationFrame(function tick(now) {
			setT(now - start);
			frame = requestAnimationFrame(tick);
		});
		return () => cancelAnimationFrame(frame);
	}, [running]);
	return t;
}

/** Counts up to `target` over `ms` whenever the target changes. */
function useCountUp(target: number, ms = 700): number {
	const [shown, setShown] = useState(target);
	useEffect(() => {
		if (reducedMotion()) {
			setShown(target);
			return;
		}
		const from = shown;
		const start = performance.now();
		let frame = requestAnimationFrame(function step(now) {
			const k = Math.min(1, (now - start) / ms);
			setShown(Math.round(from + (target - from) * (1 - (1 - k) ** 3)));
			if (k < 1) frame = requestAnimationFrame(step);
		});
		return () => cancelAnimationFrame(frame);
	}, [target]); // eslint-disable-line react-hooks/exhaustive-deps
	return shown;
}

/** Blurred symbols scrolling past while a reel spins; a fixed pattern, not a draw. */
const BLUR_STRIP: MegaSymbol[] = ['king', 'seven', 'ten', 'bell', 'queen', 'wild', 'jack', 'crown', 'ace', 'diamond', 'clover', 'scatter'];

function Reel({ symbols, spinning, reel, highlight }: { symbols: MegaSymbol[]; spinning: boolean; reel: number; highlight: Set<string> }) {
	if (spinning) {
		const strip = [...BLUR_STRIP.slice(reel * 2), ...BLUR_STRIP.slice(0, reel * 2)];
		return (
			<div className="mega__reel mega__reel--spin" aria-hidden="true">
				<div className="mega__strip" style={{ animationDelay: `${-reel * 90}ms` }}>
					{[...strip, ...strip].map((symbol, i) => (
						<div key={i} className="mega__cell">
							<MegaIcon symbol={symbol} />
						</div>
					))}
				</div>
			</div>
		);
	}
	return (
		<div className="mega__reel mega__reel--land">
			{symbols.map((symbol, row) => (
				<div key={row} className={`mega__cell${highlight.has(`${reel}:${row}`) ? ' mega__cell--hit' : ''}`}>
					<MegaIcon symbol={symbol} />
				</div>
			))}
		</div>
	);
}

const symbolsOf = (spin: MegaSpinView): MegaSymbol[][] => spin.grid.map((reel) => reel.map((i) => MEGA_SYMBOLS[i] ?? 'ten'));

export function MegaSlotsBoard({
	view,
	busy,
	onAction,
	animate,
	stake,
}: {
	view: MegaView;
	busy: boolean;
	onAction: (action: Action) => void;
	animate?: boolean;
	stake?: number;
}) {
	// The result screen stages the round; anywhere else shows it as it stands.
	const staged = !!animate && view.resolved && !reducedMotion();
	const end = megaEnd(view.free.length);
	const clock = useClock(staged);
	const t = staged ? Math.min(clock, end) : end;
	const moment = momentAt(t, view.free.length);
	const settled = view.resolved && moment.done;

	const spin = moment.spin < 0 ? view.base : view.free[moment.spin]!;
	const grid = symbolsOf(spin);
	// Before the result arrives (busy), every reel spins.
	const spinning = (reel: number) => (busy && !view.resolved) || (view.resolved && reel >= moment.stopped);
	const spinDone = view.resolved && moment.stopped === 5 && !moment.banner;

	// Trace the shown spin's winning lines one at a time, on a loop.
	const [lineIndex, setLineIndex] = useState(0);
	const hits = spinDone ? spin.hits : [];
	useEffect(() => {
		setLineIndex(0);
		if (hits.length < 2) return;
		const timer = setInterval(() => setLineIndex((i) => i + 1), 900);
		return () => clearInterval(timer);
	}, [moment.spin, spinDone, hits.length]);
	const active = hits.length > 0 ? hits[lineIndex % hits.length]! : null;
	const highlight = useMemo(() => {
		const cells = new Set<string>();
		if (active) MEGA_LINES[active.line]!.slice(0, active.count).forEach((row, reel) => cells.add(`${reel}:${row}`));
		if (spinDone && spin.scatters >= 3) {
			spin.grid.forEach((reel, r) => reel.forEach((i, row) => MEGA_SYMBOLS[i] === 'scatter' && cells.add(`${r}:${row}`)));
		}
		return cells;
	}, [active, spinDone, spin]);

	// Win so far: the base spin once landed, plus finished free spins at their multiplier.
	const baseWin = view.resolved && (moment.spin >= 0 || moment.banner || moment.stopped === 5) ? view.base.win : 0;
	const freeWin = view.free.slice(0, moment.freeDone).reduce((sum, s) => sum + s.win * MEGA_FREE_MULTIPLIER, 0);
	const winMultiple = settled ? view.total : baseWin + freeWin;
	const winChips = useCountUp(Math.round((stake ?? 0) * winMultiple));
	const tier = settled ? (view.total >= 25 ? 'mega' : view.total >= 10 ? 'big' : null) : null;

	return (
		<div className="board">
			<div className={`mega${tier ? ` mega--${tier}` : ''}${view.free.length > 0 && moment.spin >= 0 ? ' mega--bonus' : ''}`}>
				<div className="mega__marquee">
					<span className="mega__lights" aria-hidden="true" />
					<span className="mega__title">Mega Slots</span>
					<span className="mega__sub">
						{moment.spin >= 0
							? `Free spin ${moment.spin + 1} of ${view.free.length} · wins ×${MEGA_FREE_MULTIPLIER}`
							: `${MEGA_LINES.length} lines · free spins`}
					</span>
				</div>

				<div className="mega__window">
					{grid.map((symbols, reel) => (
						<Reel key={`${moment.spin}-${reel}`} reel={reel} symbols={symbols} spinning={spinning(reel)} highlight={highlight} />
					))}
					{active ? (
						<svg className="mega__lines" viewBox="0 0 5 5" preserveAspectRatio="none" aria-hidden="true">
							<polyline
								points={MEGA_LINES[active.line]!.map((row, reel) => `${reel + 0.5},${row + 0.5}`).join(' ')}
								stroke={LINE_COLORS[active.line % LINE_COLORS.length]}
							/>
						</svg>
					) : null}
					{moment.banner ? (
						<div className="mega__banner">
							<span className="mega__banner-big">{view.free.length} FREE SPINS</span>
							<span>every win ×{MEGA_FREE_MULTIPLIER}</span>
						</div>
					) : null}
					{tier ? (
						<div className={`mega__tier mega__tier--${tier}`}>
							<span>{tier === 'mega' ? 'MEGA WIN' : 'BIG WIN'}</span>
						</div>
					) : null}
				</div>

				<div className="mega__meter">
					<span className="mega__caption">
						{settled && view.free.length > 0
							? `Bonus total: ${view.total >= 10 ? Math.round(view.total) : view.total.toFixed(1)}× your bet`
							: active
								? `Line ${active.line + 1}: ${active.count} × ${MEGA_NAMES[MEGA_SYMBOLS[active.symbol] ?? 'ten']} pays ${active.pay}`
								: spinDone && spin.scatters >= 3
									? `${spin.scatters} scatters${MEGA_SCATTER_PAYS[spin.scatters] ? ` pay ${MEGA_SCATTER_PAYS[spin.scatters]}× bet` : ''}`
									: spinDone
										? moment.spin >= 0
											? 'No win this spin'
											: 'No win'
										: busy || view.resolved
											? 'Good luck!'
											: 'Press spin'}
					</span>
					<span className="mega__win">
						<span className="board__label">Win</span> {stake !== undefined ? formatChips(winChips) : `${winMultiple.toFixed(2)}×`}
					</span>
				</div>
			</div>

			<div className="btn-row">
				<button
					type="button"
					className="btn btn--primary mega__spin"
					disabled={busy || view.resolved}
					onClick={() => onAction({ type: 'SPIN' })}
				>
					{view.resolved ? 'Spun' : 'Spin'}
				</button>
			</div>

			<MegaPaytable />
		</div>
	);
}

function MegaPaytable() {
	const rows = (Object.entries(MEGA_PAYS) as [MegaSymbol, readonly [number, number, number]][]).reverse();
	return (
		<details className="paytable">
			<summary>Paytable</summary>
			<table className="mega__paytable">
				<thead>
					<tr>
						<th scope="col">Symbol</th>
						<th scope="col">×3</th>
						<th scope="col">×4</th>
						<th scope="col">×5</th>
					</tr>
				</thead>
				<tbody>
					{rows.map(([symbol, pays]) => (
						<tr key={symbol}>
							<th scope="row">
								<span className="mega__pay-icon">
									<MegaIcon symbol={symbol} />
								</span>
							</th>
							{pays.map((pay, i) => (
								<td key={i}>{pay}</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
			<p className="faint">
				Line pays are in line bets (your bet split across {MEGA_LINES.length} lines), left to right from the first
				reel. Wild stands in for any symbol but the scatter. Scatters pay anywhere: 3 for {MEGA_SCATTER_PAYS[3]}×,
				4 for {MEGA_SCATTER_PAYS[4]}×, 5 for {MEGA_SCATTER_PAYS[5]}× your bet, and 3 or more award {MEGA_FREE_SPINS} free
				spins with every win ×{MEGA_FREE_MULTIPLIER}. Returns about 92% of every chip staked.
			</p>
		</details>
	);
}

