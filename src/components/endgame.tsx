/**
 * End-of-run screens: Double or Nothing, name entry, and the run summary.
 */

import { useState } from 'react';
import { STARTING_CHIPS, TOTAL_ROUNDS, type RunState } from '../../shared/protocol';
import { formatChips, formatDelta, roundsOf, SHORT_TITLE, shareText } from '../lib/format';
import { loadName } from '../lib/savedName';
import { Leaderboard } from './Leaderboard';

// ---------------------------------------------------------------------------
// Double or Nothing
// ---------------------------------------------------------------------------

export function DoubleOrNothing({
	run,
	busy,
	onAccept,
	onDecline,
}: {
	run: RunState;
	busy: boolean;
	onAccept: () => void;
	onDecline: () => void;
}) {
	const doubles = run.current?.doubles ?? 0;
	const last = run.history[run.history.length - 1];

	return (
		<div className="panel panel--table don">
			{doubles > 0 ? <p className="don__chain">Double ×{doubles}</p> : <p className="don__chain">You won</p>}

			<h2 className="panel__title" style={{ marginTop: '0.35rem' }}>
				Double or nothing?
			</h2>
			<p className="panel__sub">
				Replay {last ? titleFor(last.game) : 'the round'} with {formatChips(run.current?.bet ?? 0)} on the line —
				your bet plus what you just won. Lose it and the rest of your stack is untouched.
			</p>

			<p className="don__stack">{formatChips(run.chips)}</p>

			<div className="btn-row" style={{ marginTop: '1rem' }}>
				<button type="button" className="btn btn--win" disabled={busy} onClick={onAccept}>
					Double it
				</button>
				<button type="button" className="btn" disabled={busy} onClick={onDecline}>
					Keep it
				</button>
			</div>

			<p className="faint" style={{ marginBottom: 0 }}>
				Unlimited doubles — you can keep pushing your luck.
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Name entry
// ---------------------------------------------------------------------------

export function NameEntry({
	run,
	busy,
	error,
	onSubmit,
	onAbandon,
}: {
	run: RunState;
	busy: boolean;
	error: string | null;
	onSubmit: (name: string) => void;
	onAbandon: () => void;
}) {
	const [name, setName] = useState(loadName);
	const bust = run.endedBy === 'bust';

	return (
		<>
			<Summary run={run} />

			<form
				className="panel panel--table"
				onSubmit={(event) => {
					event.preventDefault();
					onSubmit(name);
				}}
			>
				<h2 className="panel__title">Claim your spot</h2>
				<p className="panel__sub">
					One entry per name per day. {bust ? 'A bust still gets you on the board.' : ''}
				</p>

				<div className="name-form">
					<label className="faint" htmlFor="gambadle-name">
						Your name
					</label>
					<input
						id="gambadle-name"
						className="input"
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder="Two to sixteen characters"
						autoComplete="off"
						autoCapitalize="off"
						autoCorrect="off"
						maxLength={32}
						disabled={busy}
					/>
					{error ? (
						<p className="error" role="alert">
							{error}
						</p>
					) : null}
					<button type="submit" className="btn btn--primary btn--block" disabled={busy}>
						Submit score
					</button>
				</div>
			</form>

			<button type="button" className="btn btn--ghost btn--block" disabled={busy} onClick={onAbandon}>
				Start over instead
			</button>
			<p className="faint" style={{ textAlign: 'center' }}>
				Starting over means any later run today will not be ranked.
			</p>
		</>
	);
}

/** The end of a run that is not eligible for the leaderboard: results, but no name form. */
export function UnrankedEnd({
	run,
	busy,
	onAbandon,
}: {
	run: RunState;
	busy: boolean;
	onAbandon: () => void;
}) {
	return (
		<>
			<Summary run={run} />
			<p className="notice">
				Only your first run of the day can go on the leaderboard, so this one is unranked.
			</p>
			<button type="button" className="btn btn--block" disabled={busy} onClick={onAbandon}>
				Play again
			</button>
		</>
	);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** Copies (or natively shares) the run, one line per round, plus a link to the game. */
function ShareButton({ run }: { run: RunState }) {
	const [label, setLabel] = useState('Share results');

	const share = async () => {
		const text = shareText(run, window.location.origin);
		try {
			if (navigator.share) {
				await navigator.share({ text });
				return;
			}
			await navigator.clipboard.writeText(text);
			setLabel('Copied!');
		} catch (error) {
			// Dismissing the share sheet is not a failure worth reporting.
			if (error instanceof DOMException && error.name === 'AbortError') return;
			setLabel('Could not copy');
		}
		setTimeout(() => setLabel('Share results'), 2000);
	};

	return (
		<button type="button" className="btn btn--block" onClick={() => void share()}>
			{label}
		</button>
	);
}

export function Summary({ run }: { run: RunState }) {
	const bust = run.endedBy === 'bust';
	const net = run.chips - STARTING_CHIPS;
	const rounds = run.history.filter((r) => !r.doubled).length;

	return (
		<div className="panel panel--table result">
			<p className={`result__headline result__headline--${bust ? 'loss' : 'win'}`}>
				{bust ? 'Busted' : `Survived ${TOTAL_ROUNDS} rounds`}
			</p>
			<p className={`delta delta--${net >= 0 ? 'win' : 'loss'}`} style={{ margin: '0.2rem 0' }}>
				{formatChips(run.chips)}
			</p>
			<p className="result__detail">
				{formatDelta(net)} against a {formatChips(STARTING_CHIPS)} start, across {rounds} round
				{rounds === 1 ? '' : 's'}.
			</p>
			{/* The share card as it will read: one row per round. */}
			<ol className="share-card">
				{roundsOf(run.history).map((r) => (
					<li key={r.round} className="share-card__row">
						<span className={`share-card__square share-card__square--${r.net > 0 ? 'win' : r.net < 0 ? 'loss' : 'push'}`} />
						<span className="share-card__game">
							{SHORT_TITLE[r.game]}
							{r.doubles > 0 ? <span className="log__doubled">×{r.doubles + 1}</span> : null}
						</span>
						<span className={`share-card__net delta--${r.net > 0 ? 'win' : r.net < 0 ? 'loss' : 'push'}`}>
							{formatDelta(r.net)}
						</span>
					</li>
				))}
			</ol>
			<ShareButton run={run} />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Submitted
// ---------------------------------------------------------------------------

export function Submitted({ run, onRestart }: { run: RunState; onRestart: () => void }) {
	return (
		<>
			<Summary run={run} />
			<Leaderboard highlight="submitted" />
			<button type="button" className="btn btn--block" onClick={onRestart}>
				Play again
			</button>
			<p className="faint" style={{ textAlign: 'center' }}>
				One entry per name per day — the board clears at midnight ET.
			</p>
		</>
	);
}

// ---------------------------------------------------------------------------
// Round log
// ---------------------------------------------------------------------------

export function RoundLog({ run }: { run: RunState }) {
	if (run.history.length === 0) return null;
	return (
		<div className="log">
			{run.history.map((entry, index) => (
				<div className="log__row" key={index}>
					<span className="log__round">{entry.doubled ? '↺' : entry.round}</span>
					<span className="log__game">{titleFor(entry.game)}</span>
					{entry.doubled ? <span className="log__doubled">DOUBLE</span> : <span />}
					<span className={`log__delta log__delta--${entry.net > 0 ? 'win' : entry.net < 0 ? 'loss' : ''}`}>
						{formatDelta(entry.net)}
					</span>
				</div>
			))}
		</div>
	);
}

function titleFor(game: string): string {
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
		}[game] ?? game
	);
}