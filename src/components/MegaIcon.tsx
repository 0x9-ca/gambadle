/**
 * Mega Slots symbols, drawn as SVG: card ranks for the low symbols (as real
 * video slots do), the classic slot art for the premiums, and badges for Wild
 * and Scatter.
 */

import { useId } from 'react';
import type { MegaSymbol } from '../../shared/megaslots';
import type { SlotSymbol } from '../../shared/games';
import { SlotIcon } from './SlotIcon';

/** Low symbols: the rank in a coloured gem-cut face. */
const RANKS: Partial<Record<MegaSymbol, { text: string; from: string; to: string }>> = {
	ten: { text: '10', from: '#7dd3fc', to: '#0369a1' },
	jack: { text: 'J', from: '#86efac', to: '#15803d' },
	queen: { text: 'Q', from: '#f9a8d4', to: '#be185d' },
	king: { text: 'K', from: '#c4b5fd', to: '#6d28d9' },
	ace: { text: 'A', from: '#fdba74', to: '#c2410c' },
};

const PREMIUM: Partial<Record<MegaSymbol, SlotSymbol>> = {
	clover: 'clover',
	bell: 'bell',
	diamond: 'diamond',
	crown: 'crown',
	seven: 'seven',
};

/** Display names, for captions. */
export const MEGA_NAMES: Record<MegaSymbol, string> = {
	ten: '10',
	jack: 'Jack',
	queen: 'Queen',
	king: 'King',
	ace: 'Ace',
	clover: 'Clover',
	bell: 'Bell',
	diamond: 'Diamond',
	crown: 'Crown',
	seven: 'Seven',
	wild: 'Wild',
	scatter: 'Scatter',
};

export function MegaIcon({ symbol }: { symbol: MegaSymbol }) {
	// Gradients are referenced by id, and a reel strip is mounted and unmounted
	// constantly; a shared id breaks when the element that defined it goes, so
	// each icon defines its own.
	const uid = `m${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
	const premium = PREMIUM[symbol];
	if (premium) return <SlotIcon symbol={premium} size="100%" />;

	const rank = RANKS[symbol];
	if (rank) {
		const id = `${uid}-${symbol}`;
		return (
			<svg viewBox="0 0 40 40" width="100%" height="100%" role="img" aria-label={rank.text} className="slot-icon">
				<defs>
					<linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
						<stop offset="0" stopColor={rank.from} />
						<stop offset="1" stopColor={rank.to} />
					</linearGradient>
				</defs>
				<text
					x="20"
					y="30"
					textAnchor="middle"
					fontFamily="Georgia, 'Times New Roman', serif"
					fontWeight="900"
					fontSize={rank.text.length > 1 ? 22 : 28}
					fill={`url(#${id})`}
					stroke="#111"
					strokeWidth="1.2"
					paintOrder="stroke"
				>
					{rank.text}
				</text>
			</svg>
		);
	}

	if (symbol === 'wild') {
		return (
			<svg viewBox="0 0 40 40" width="100%" height="100%" role="img" aria-label="Wild" className="slot-icon">
				<defs>
					<linearGradient id={`${uid}-wild`} x1="0" y1="0" x2="1" y2="1">
						<stop offset="0" stopColor="#fde68a" />
						<stop offset="0.5" stopColor="#f59e0b" />
						<stop offset="1" stopColor="#b45309" />
					</linearGradient>
				</defs>
				<rect x="2" y="9" width="36" height="22" rx="5" fill={`url(#${uid}-wild)`} stroke="#78350f" strokeWidth="1.5" />
				<text x="20" y="25" textAnchor="middle" fontFamily="Impact, 'Arial Black', sans-serif" fontWeight="900" fontSize="13" fill="#3b0764" letterSpacing="0.5">
					WILD
				</text>
			</svg>
		);
	}

	// Scatter: a starburst badge.
	return (
		<svg viewBox="0 0 40 40" width="100%" height="100%" role="img" aria-label="Scatter" className="slot-icon">
			<defs>
				<radialGradient id={`${uid}-scatter`}>
					<stop offset="0" stopColor="#fef3c7" />
					<stop offset="0.6" stopColor="#ec4899" />
					<stop offset="1" stopColor="#7e22ce" />
				</radialGradient>
			</defs>
			<polygon
				points="20,1 24,12 35,7 29,18 39,22 28,25 32,37 21,30 13,39 13,27 2,26 11,19 4,9 16,12"
				fill={`url(#${uid}-scatter)`}
				stroke="#4c1d95"
				strokeWidth="1.2"
				strokeLinejoin="round"
			/>
			<text x="20" y="23.5" textAnchor="middle" fontFamily="Impact, 'Arial Black', sans-serif" fontSize="7.5" fill="#fff" stroke="#4c1d95" strokeWidth="0.6" paintOrder="stroke">
				BONUS
			</text>
		</svg>
	);
}
