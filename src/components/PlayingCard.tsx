/**
 * A playing card, drawn in CSS rather than loaded as an image.
 *
 * Keeps the bundle tiny and lets the back be a CSS gradient. A hidden card is
 * passed as a `null` suit so callers do not have to fake a face.
 */

import type { CardView, Suit } from '../../shared/protocol';

const SUIT_PIP: Record<Suit, string> = {
	s: '♠',
	h: '♥',
	d: '♦',
	c: '♣',
};

const RANK_TEXT: Record<number, string> = {
	1: 'A',
	2: '2',
	3: '3',
	4: '4',
	5: '5',
	6: '6',
	7: '7',
	8: '8',
	9: '9',
	10: '10',
	11: 'J',
	12: 'Q',
	13: 'K',
};

/**
 * How a card arrives: `deal` slides it in, `flip` turns a face-down card over,
 * `still` is for a card the player has already seen.
 */
export type CardMotion = 'deal' | 'flip' | 'still';

export function PlayingCard({
	card,
	faceDown = false,
	motion = 'deal',
	delay = 0,
}: {
	card?: CardView;
	faceDown?: boolean;
	motion?: CardMotion;
	/** Milliseconds before the motion starts, to stagger a deal. */
	delay?: number;
}) {
	const motionClass = motion === 'still' ? '' : ` card--${motion}`;
	const style = delay > 0 ? { animationDelay: `${delay}ms` } : undefined;

	if (faceDown || !card) {
		return (
			<div className={`card card--back${motionClass}`} style={style} aria-label="Face-down card">
				<span className="card__corner" />
				<span className="card__pip">★</span>
				<span className="card__corner" />
			</div>
		);
	}

	// Pai Gow's joker is the only card with rank 0.
	if (card.rank === 0) {
		return (
			<div className={`card card--joker${motionClass}`} style={style} aria-label="Joker">
				<span className="card__corner">JKR</span>
				<span className="card__pip">★</span>
				<span className="card__corner">JKR</span>
			</div>
		);
	}

	const red = card.suit === 'h' || card.suit === 'd';
	const label = `${RANK_TEXT[card.rank]}${SUIT_PIP[card.suit]}`;

	return (
		<div
			className={`card${red ? ' card--red' : ''}${motionClass}`}
			style={style}
			aria-label={label}
			data-rank={RANK_TEXT[card.rank]}
		>
			<span className="card__corner">{label}</span>
			<span className="card__pip">{SUIT_PIP[card.suit]}</span>
			<span className="card__corner">{label}</span>
		</div>
	);
}

/**
 * `hideLast` turns only the final card face down, as for a dealer's hole card.
 *
 * `still` is how many leading cards the player has already seen, so a result
 * board only animates what is new; `flip` is the index of a card to turn over
 * rather than deal, which is how a hole card is revealed.
 */
export function Hand({
	cards,
	faceDown = false,
	hideLast = false,
	still = 0,
	flip = -1,
}: {
	cards: CardView[];
	faceDown?: boolean;
	hideLast?: boolean;
	still?: number;
	flip?: number;
}) {
	// Four or more cards (a few hits) drop a size, and five or more overlap like
	// a fanned hand, so a long hand stays on one line.
	const size = cards.length >= 5 ? ' hand--compact hand--fan' : cards.length >= 4 ? ' hand--compact' : '';
	return (
		<div className={`hand${size}`}>
			{cards.map((card, index) => {
				let motion: CardMotion = 'deal';
				let delay = 0;
				if (index === flip) {
					motion = 'flip';
					delay = 600;
				} else if (index < still) {
					motion = 'still';
				} else if (flip >= 0 && index < flip) {
					// Cards dealt before the one that turns over land first.
					delay = index * 150;
				} else if (still > 0 || flip >= 0) {
					// New cards on a result board arrive one after another, after any flip.
					delay = (flip >= 0 ? 900 : 0) + Math.max(0, index - Math.max(still, flip + 1)) * 250;
				} else {
					// An opening deal: the first two cards of a hand land in quick sequence,
					// while a later hit arrives at once.
					delay = index < 2 ? index * 150 : 0;
				}
				return (
					// Cards have no stable id across a deal, so the index is the identity.
					// eslint-disable-next-line react/no-array-index-key
					<PlayingCard
						key={index}
						card={card}
						faceDown={faceDown || (hideLast && index === cards.length - 1)}
						motion={motion}
						delay={delay}
					/>
				);
			})}
		</div>
	);
}
