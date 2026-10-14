/**
 * Gambadle client.
 *
 * The client is a pure function of the server's `RunState`. It sends intents and
 * renders whatever comes back — it holds no chips, no cards and no randomness,
 * which is what keeps the leaderboard honest.
 */

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	STARTING_CHIPS,
	TOTAL_ROUNDS,
	type Action,
	type RoundResult,
	type RunState,
	type RunView,
	type Wager,
} from '../shared/protocol';
import { GameBoard } from './components/boards';
import { DoubleOrNothing, NameEntry, RoundLog, Submitted, UnrankedEnd } from './components/endgame';
import { Leaderboard } from './components/Leaderboard';
import { Stats } from './components/Stats';
import { BetScreen, ChoosingScreen, ResultPanel } from './components/screens';
import { ApiRequestError, fetchState, sendAction } from './lib/api';
import { formatChips, formatCountdown, formatDay } from './lib/format';
import { revealSeconds } from './lib/reveal';
import { saveName } from './lib/savedName';

export default function App() {
	const [view, setView] = useState<RunView | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loaded, setLoaded] = useState(false);

	// Guards against a slow reply overwriting newer state, and against setting
	// state after unmount.
	const requestSeq = useRef(0);

	/**
	 * Sends one intent and adopts the state the Worker returns.
	 *
	 * Resolves to the failure message, or null on success. When `quiet` is set
	 * the message is returned rather than put in the page banner — the name form
	 * renders its own error next to the input.
	 */
	const act = useCallback(
		async (action: Action, quiet = false): Promise<string | null> => {
			const seq = ++requestSeq.current;
			setBusy(true);
			if (!quiet) setError(null);
			try {
				const next = await sendAction(action);
				if (seq === requestSeq.current) setView(next);
				return null;
			} catch (cause) {
				const message =
					cause instanceof ApiRequestError ? cause.message : 'Something went wrong';
				if (seq === requestSeq.current && !quiet) setError(message);
				return message;
			} finally {
				if (seq === requestSeq.current) setBusy(false);
			}
		},
		[]
	);

	// Restore any run in progress. A `daily` reset reason means yesterday's run
	// was voided, so the banner explains why the player is back at 1000.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const initial = await fetchState();
				if (!cancelled) setView(initial);
			} catch (cause) {
				if (!cancelled) {
					setError(cause instanceof ApiRequestError ? cause.message : 'Could not reach the table');
				}
			} finally {
				if (!cancelled) setLoaded(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const run = view?.run ?? null;
	const shown = useRevealHold(run);

	return (
		<>
			<header className="topbar">
				<div className="topbar__inner">
					<span className="brand">Gambadle</span>
					{shown ? <RoundPips run={shown.run} /> : null}
					{run && run.eligible === false ? <span className="topbar__tag">Unranked</span> : null}
					{run && run.eligible !== false && run.seed ? (
						<span className="topbar__tag" title={`Daily run for ${run.seed}`}>
							{formatDay(run.seed)}
						</span>
					) : null}
					<span className="topbar__spacer" />
					<span className={`chips${shown?.flash ? ` chips--flash-${shown.flash}` : ''}`}>
						<span className="chips__label">Chips</span>
						{shown ? formatChips(shown.chips) : '—'}
					</span>
				</div>
			</header>

			<div className="app">
				<main className="app__main">
					{view?.resetReason === 'daily' ? (
						<p className="notice">
							It&apos;s a new day. You&apos;re back to {formatChips(STARTING_CHIPS)} chips.
						</p>
					) : null}

					{error ? (
						<p className="error" role="alert">
							{error}
						</p>
					) : null}

					{!loaded ? (
						<p className="faint" style={{ textAlign: 'center' }}>
							Taking your seat…
						</p>
					) : run === null ? (
						<StartScreen
							busy={busy}
							ranked={view?.rankedAvailable !== false}
							onStart={() => void act({ type: 'START' })}
						/>
					) : (
						<Play run={run} busy={busy} act={act} />
					)}

					{shown ? <RoundLog run={shown.run} /> : null}
					{/* Refreshes when a run finishes, once its reveal has played out. */}
					<Stats refreshKey={shown?.run.phase === 'finished' ? `done-${shown.run.history.length}` : 'live'} />
					<Leaderboard />
				</main>

				<footer className="faint" style={{ textAlign: 'center', paddingTop: '0.5rem' }}>
					<Countdown seconds={view?.secondsUntilReset} />
					<br />
					Play money only. No purchase, no cash-out.
				</footer>
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------

function StartScreen({
	busy,
	ranked,
	onStart,
}: {
	busy: boolean;
	/** False once today's one ranked run has been started. */
	ranked: boolean;
	onStart: () => void;
}) {
	return (
		<div className="panel panel--table result">
			<h1 className="panel__title" style={{ fontSize: '1.6rem' }}>
				Gambadle
			</h1>
			<p className="result__detail">
				Start with {formatChips(STARTING_CHIPS)} chips and play {TOTAL_ROUNDS} rounds of randomly drawn
				casino games.
			</p>
			<p className="result__detail">
				Hit zero and the run is over. Survive all {TOTAL_ROUNDS} and you post the biggest stack you can.
			</p>
			<p className="result__detail">
				{ranked
					? 'Only your first run each day can reach the leaderboard.'
					: 'You have already started a run today, so this one will not be ranked.'}
			</p>
			<button
				type="button"
				className="btn btn--primary btn--block"
				style={{ marginTop: '1rem' }}
				disabled={busy}
				onClick={onStart}
			>
				{busy ? 'Dealing…' : ranked ? 'Start a run' : 'Start an unranked run'}
			</button>
		</div>
	);
}

type Act = (action: Action, quiet?: boolean) => Promise<string | null>;

/**
 * Holds back whatever follows a result (the next bet, a Double or Nothing
 * offer, the end of the run) until the result board has played out, since
 * each of those gives the outcome away. Hidden panels cannot be tapped.
 */
function AfterReveal({ result, children }: { result: RoundResult | null; children: ReactNode }) {
	const delay = revealSeconds(result);
	if (delay <= 0) return <>{children}</>;
	return (
		<div className="reveal" style={{ animationDelay: `${delay}s` }}>
			{children}
		</div>
	);
}

function Play({ run, busy, act }: { run: RunState; busy: boolean; act: Act }) {
	const confirmWager = useCallback((wager: Wager) => void act({ type: 'WAGER', wager }), [act]);
	const lastResult = useMemo(
		() => run.history[run.history.length - 1] ?? null,
		[run.history]
	);

	// With no round open there is nothing to play, so the last round's result is
	// shown above the bet table rather than on an empty screen.
	switch (run.phase) {
		case 'betting':
			return (
				<>
					{lastResult ? <ResultPanel result={lastResult} chips={run.chips} /> : null}
					<AfterReveal result={lastResult}>
						<BetScreen run={run} busy={busy} onBegin={(bet) => void act({ type: 'BEGIN_ROUND', bet })} />
					</AfterReveal>
				</>
			);

		case 'choosing':
			return run.current ? (
				<ChoosingScreen
					game={run.current.game}
					seedWager={run.current.wager}
					bet={run.current.bet}
					stack={run.chips}
					busy={busy}
					onConfirm={confirmWager}
				/>
			) : null;

		case 'in_game':
			return run.current?.view ? (
				<div className="panel panel--table">
					<div className={busy ? 'busy' : undefined}>
						<GameBoard view={run.current.view} busy={busy} onAction={(action) => void act(action)} stake={run.current.bet} />
					</div>
				</div>
			) : null;

		case 'don_offer':
			return (
				<>
					{lastResult ? <ResultPanel result={lastResult} chips={run.chips} /> : null}
					<AfterReveal result={lastResult}>
						<DoubleOrNothing
							run={run}
							busy={busy}
							onAccept={() => void act({ type: 'DON_ACCEPT' })}
							onDecline={() => void act({ type: 'DON_DECLINE' })}
						/>
					</AfterReveal>
				</>
			);

		case 'finished':
			return (
				<>
					{lastResult ? <ResultPanel result={lastResult} chips={run.chips} /> : null}
					<AfterReveal result={lastResult}>
						<NameEntryHost run={run} busy={busy} act={act} />
					</AfterReveal>
				</>
			);

		case 'submitted':
			return <Submitted run={run} onRestart={() => void act({ type: 'ABANDON' })} />;
	}
}

/**
 * Wraps the name form so a rejected submission shows its error inline, under
 * the input, instead of in the page banner far above it.
 */
function NameEntryHost({ run, busy, act }: { run: RunState; busy: boolean; act: Act }) {
	const [submitError, setSubmitError] = useState<string | null>(null);

	const submit = async (name: string) => {
		const error = await act({ type: 'SUBMIT_NAME', name }, true);
		// Only remember a name the server accepted.
		if (!error) saveName(name.trim());
		setSubmitError(error);
	};

	// An unranked run never reaches the name form: it can only be shared or replaced.
	if (run.eligible === false) {
		return <UnrankedEnd run={run} busy={busy} onAbandon={() => void act({ type: 'ABANDON' })} />;
	}

	return (
		<NameEntry
			run={run}
			busy={busy}
			error={submitError}
			onSubmit={(name) => void submit(name)}
			onAbandon={() => void act({ type: 'ABANDON' })}
		/>
	);
}

// ---------------------------------------------------------------------------

/**
 * The run as the header and round log should show it.
 *
 * When a round settles, the server's state already holds the new stack, but
 * the result board is still playing its reveal. Until it finishes, this keeps
 * showing the stack and history from before the round, then counts the chips
 * over to the new total and flashes them green or red.
 */
function useRevealHold(run: RunState | null): { run: RunState; chips: number; flash: 'win' | 'loss' | null } | null {
	const settled = run?.history.length ?? 0;
	const seen = useRef<number | null>(null);
	const primed = useRef(false);
	const [heldUntil, setHeldUntil] = useState<number | null>(null);
	const [chips, setChips] = useState(run?.chips ?? 0);
	const [flash, setFlash] = useState<'win' | 'loss' | null>(null);

	// A new history entry starts a hold for that game's reveal. The first state
	// seen (a page load) is shown as it is.
	useEffect(() => {
		if (!run) {
			seen.current = null;
			return;
		}
		const previous = seen.current;
		seen.current = settled;
		if (previous === null || settled <= previous) return;
		const ms = revealSeconds(run.history[settled - 1] ?? null) * 1000;
		if (ms <= 0) return;
		setHeldUntil(settled);
		const timer = setTimeout(() => setHeldUntil(null), ms);
		return () => clearTimeout(timer);
	}, [run, settled]);

	const holding = run !== null && heldUntil === settled;
	const last = run?.history[settled - 1];
	const target = run ? (holding && last ? run.chips - last.net : run.chips) : 0;

	// Count to the target rather than jumping, unless motion is unwelcome. The
	// first stack seen (a page load) is simply shown.
	useEffect(() => {
		if (!run) return;
		if (!primed.current) {
			primed.current = true;
			setChips(target);
			return;
		}
		if (chips === target) return;
		const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		setFlash(target > chips ? 'win' : 'loss');
		const clear = setTimeout(() => setFlash(null), 900);
		if (reduced) {
			setChips(target);
			return () => clearTimeout(clear);
		}
		const from = chips;
		const start = performance.now();
		let frame = requestAnimationFrame(function step(now) {
			const t = Math.min(1, (now - start) / 600);
			const eased = 1 - (1 - t) ** 3;
			setChips(Math.round(from + (target - from) * eased));
			if (t < 1) frame = requestAnimationFrame(step);
		});
		return () => {
			cancelAnimationFrame(frame);
			clearTimeout(clear);
		};
	}, [target, run !== null]); // eslint-disable-line react-hooks/exhaustive-deps

	if (!run) return null;
	const shownRun = holding
		? { ...run, history: run.history.slice(0, -1), round: last?.round ?? run.round, phase: 'in_game' as const }
		: run;
	return { run: shownRun, chips, flash };
}

function RoundPips({ run }: { run: RunState }) {
	// One pip per round, coloured by how the round ended up: a Double or Nothing
	// chain adds several history entries to one round, so they are summed.
	return (
		<div className="pips" aria-label={`Round ${Math.min(run.round, TOTAL_ROUNDS)} of ${TOTAL_ROUNDS}`}>
			{Array.from({ length: TOTAL_ROUNDS }, (_, index) => {
				const entries = run.history.filter((entry) => entry.round === index + 1);
				const net = entries.reduce((sum, entry) => sum + entry.net, 0);
				const current = run.phase !== 'finished' && run.phase !== 'submitted' && index === run.round - 1;
				const className =
					entries.length > 0 && !current
						? net < 0
							? 'pip pip--lost'
							: 'pip pip--done'
						: current
							? 'pip pip--current'
							: 'pip';
				return <span key={index} className={className} />;
			})}
		</div>
	);
}

function Countdown({ seconds }: { seconds: number | undefined }) {
	const [remaining, setRemaining] = useState(seconds ?? 0);

	// Ticks locally between server responses so the clock stays smooth.
	useEffect(() => {
		if (seconds === undefined) return;
		setRemaining(seconds);
		const timer = setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
		return () => clearInterval(timer);
	}, [seconds]);

	return <span className="countdown">Resets in {formatCountdown(remaining)} ET</span>;
}