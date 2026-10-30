/**
 * The staging deployment's practice mode: pick one game, play it from a fresh
 * 1,000 chips, reset whenever you like. Nothing is ranked or recorded, so these
 * screens replace the start screen, the round pips and the leaderboard.
 */

import { GAME_IDS, STARTING_CHIPS, type GameId } from '../../shared/protocol';
import { formatChips, SHORT_TITLE } from '../lib/format';

export function PracticeMenu({ busy, onPick }: { busy: boolean; onPick: (game: GameId) => void }) {
	return (
		<div className="panel panel--table result">
			<h1 className="panel__title" style={{ fontSize: '1.6rem' }}>
				Gambadle staging
			</h1>
			<p className="result__detail">
				Pick a game to test on its own. You start with {formatChips(STARTING_CHIPS)} practice chips and play it
				round after round until you reset or go broke.
			</p>
			<p className="result__detail">Nothing here is ranked, recorded or on the leaderboard.</p>
			<div className="choice-grid choice-grid--2" style={{ marginTop: '1rem' }}>
				{GAME_IDS.map((game) => (
					<button key={game} type="button" className="choice" disabled={busy} onClick={() => onPick(game)}>
						{SHORT_TITLE[game]}
					</button>
				))}
			</div>
		</div>
	);
}

/** Above the table during practice: which game this is, and the two ways out. */
export function PracticeBar({
	game,
	busy,
	onReset,
	onChange,
}: {
	game: GameId;
	busy: boolean;
	onReset: () => void;
	onChange: () => void;
}) {
	return (
		<div className="panel panel--table" style={{ padding: '0.6rem 0.75rem' }}>
			<p className="faint" style={{ margin: '0 0 0.5rem', textAlign: 'center' }}>
				Practising {SHORT_TITLE[game]}
			</p>
			<div className="btn-row">
				<button type="button" className="btn btn--ghost" disabled={busy} onClick={onReset}>
					Reset to {formatChips(STARTING_CHIPS)}
				</button>
				<button type="button" className="btn btn--ghost" disabled={busy} onClick={onChange}>
					Change game
				</button>
			</div>
		</div>
	);
}

/** A practice stack that can no longer open the game: the bar's reset is the way on, said plainly. */
export function PracticeBust({ game, busy, onReset, onChange }: { game: GameId; busy: boolean; onReset: () => void; onChange: () => void }) {
	return (
		<div className="panel panel--table result">
			<h2 className="panel__title">Out of chips</h2>
			<p className="result__detail">Not enough left to play {SHORT_TITLE[game]}.</p>
			<div className="btn-row" style={{ marginTop: '1rem' }}>
				<button type="button" className="btn btn--primary" disabled={busy} onClick={onReset}>
					Reset to {formatChips(STARTING_CHIPS)}
				</button>
				<button type="button" className="btn" disabled={busy} onClick={onChange}>
					Change game
				</button>
			</div>
		</div>
	);
}
