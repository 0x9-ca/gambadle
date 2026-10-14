/**
 * The twelve slot symbols, drawn as inline SVG.
 *
 * Emoji were used before, but they look different on every platform and show
 * as empty boxes where the font has none. These are drawn on a 40×40 grid.
 */

import type { ReactNode } from 'react';
import type { SlotSymbol } from '../../shared/games';

const SHAPES: Record<SlotSymbol, ReactNode> = {
	cherry: (
		<>
			<path d="M20 6 C18 14 14 18 12 24 M20 6 C22 14 26 18 28 22" stroke="#3f7d2c" strokeWidth="2.2" fill="none" strokeLinecap="round" />
			<path d="M20 6 C25 3 31 5 33 9 C28 11 23 10 20 6 Z" fill="#4caf50" />
			<circle cx="12" cy="28" r="7" fill="#d4202c" />
			<circle cx="28" cy="27" r="7" fill="#e0303a" />
			<circle cx="10" cy="26" r="1.8" fill="#ff9a9a" />
			<circle cx="26" cy="25" r="1.8" fill="#ff9a9a" />
		</>
	),
	lemon: (
		<>
			<path d="M5 21 C7 11 16 7 24 8 C30 9 35 14 35 20 C33 29 24 33 16 32 C10 31 6 27 5 21 Z" fill="#f5d020" stroke="#c9a400" strokeWidth="1.2" />
			<path d="M35 20 L38 19 M5 21 L2 22" stroke="#c9a400" strokeWidth="2" strokeLinecap="round" />
			<ellipse cx="15" cy="15" rx="5" ry="2.2" fill="#fff6a8" transform="rotate(-25 15 15)" />
		</>
	),
	bell: (
		<>
			<path d="M20 5 C12 5 10 12 10 19 C10 25 7 27 6 30 L34 30 C33 27 30 25 30 19 C30 12 28 5 20 5 Z" fill="#f2b632" stroke="#a87613" strokeWidth="1.2" />
			<rect x="5" y="29" width="30" height="3.5" rx="1.7" fill="#d79a1d" />
			<circle cx="20" cy="35" r="3" fill="#a87613" />
			<path d="M15 10 C13 14 13 18 13 22" stroke="#ffe08a" strokeWidth="2" fill="none" strokeLinecap="round" />
		</>
	),
	clover: (
		<>
			<path d="M20 22 C21 28 24 33 28 37" stroke="#2e7d32" strokeWidth="2.2" fill="none" strokeLinecap="round" />
			<circle cx="14" cy="14" r="6.5" fill="#43a047" />
			<circle cx="26" cy="14" r="6.5" fill="#4caf50" />
			<circle cx="14" cy="26" r="6.5" fill="#4caf50" />
			<circle cx="26" cy="26" r="6.5" fill="#43a047" />
			<circle cx="20" cy="20" r="3" fill="#2e7d32" />
		</>
	),
	star: (
		<polygon
			points="20,3 24.9,14.2 37,15.3 27.8,23.4 30.6,35.3 20,29 9.4,35.3 12.2,23.4 3,15.3 15.1,14.2"
			fill="#ffd23f"
			stroke="#c99400"
			strokeWidth="1.4"
			strokeLinejoin="round"
		/>
	),
	diamond: (
		<>
			<polygon points="10,8 30,8 37,16 20,36 3,16" fill="#4dd0e1" stroke="#0097a7" strokeWidth="1.2" strokeLinejoin="round" />
			<polygon points="10,8 15,16 20,8 25,16 30,8" fill="#b2ebf2" />
			<polygon points="3,16 37,16 20,36" fill="#26c6da" />
			<polygon points="15,16 25,16 20,36" fill="#80deea" />
		</>
	),
	melon: (
		<>
			<path d="M4 14 L36 14 C36 25 29 34 20 34 C11 34 4 25 4 14 Z" fill="#2e7d32" />
			<path d="M7 14 L33 14 C33 23 27 31 20 31 C13 31 7 23 7 14 Z" fill="#a5d6a7" />
			<path d="M9 14 L31 14 C31 22 26 29 20 29 C14 29 9 22 9 14 Z" fill="#ef4f5f" />
			<ellipse cx="15" cy="19" rx="1" ry="1.6" fill="#222" />
			<ellipse cx="20" cy="23" rx="1" ry="1.6" fill="#222" />
			<ellipse cx="25" cy="19" rx="1" ry="1.6" fill="#222" />
		</>
	),
	grape: (
		<>
			<path d="M20 9 C20 6 22 4 24 3" stroke="#5d4037" strokeWidth="2" fill="none" strokeLinecap="round" />
			<path d="M21 8 C26 4 32 6 33 10 C28 12 24 11 21 8 Z" fill="#4caf50" />
			{[
				[14, 13],
				[20, 13],
				[26, 13],
				[17, 19],
				[23, 19],
				[11, 19],
				[29, 19],
				[14, 25],
				[20, 25],
				[26, 25],
				[17, 31],
				[23, 31],
				[20, 36],
			].map(([cx, cy]) => (
				<circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="3.6" fill="#7b3fa0" stroke="#4a1f66" strokeWidth="0.8" />
			))}
		</>
	),
	gift: (
		<>
			<rect x="6" y="16" width="28" height="20" rx="2" fill="#d32f2f" />
			<rect x="4" y="11" width="32" height="7" rx="1.5" fill="#e53935" />
			<rect x="17.5" y="11" width="5" height="25" fill="#ffd23f" />
			<path d="M20 11 C14 4 8 6 10 10 C11 12 16 12 20 11 C24 12 29 12 30 10 C32 6 26 4 20 11 Z" fill="#ffd23f" stroke="#c99400" strokeWidth="1" />
		</>
	),
	coin: (
		<>
			<circle cx="20" cy="20" r="16" fill="#f2b632" stroke="#a87613" strokeWidth="1.5" />
			<circle cx="20" cy="20" r="12" fill="none" stroke="#d79a1d" strokeWidth="1.5" />
			<path d="M23.5 14.5 C22 13 17 13 16.5 16 C16 19 24 19 23.8 23 C23.5 26.5 17.5 26.5 16 25" stroke="#7a5409" strokeWidth="2.4" fill="none" strokeLinecap="round" />
			<path d="M20 11 V29" stroke="#7a5409" strokeWidth="2" strokeLinecap="round" />
		</>
	),
	crown: (
		<>
			<polygon points="5,30 4,12 13,20 20,7 27,20 36,12 35,30" fill="#ffd23f" stroke="#c99400" strokeWidth="1.4" strokeLinejoin="round" />
			<rect x="5" y="29" width="30" height="5" rx="1.2" fill="#e0a800" />
			<circle cx="20" cy="22" r="2.6" fill="#e53935" />
			<circle cx="12" cy="25" r="1.8" fill="#1e88e5" />
			<circle cx="28" cy="25" r="1.8" fill="#1e88e5" />
		</>
	),
	seven: (
		<path
			d="M8 7 H33 V12 C26 19 21 27 19.5 35 H11.5 C13 27 18 19 24 13 H8 Z"
			fill="#e53935"
			stroke="#8e0000"
			strokeWidth="1.6"
			strokeLinejoin="round"
		/>
	),
};

export function SlotIcon({ symbol, size = '1em' }: { symbol: SlotSymbol; size?: string }) {
	return (
		<svg viewBox="0 0 40 40" width={size} height={size} role="img" aria-label={symbol} className="slot-icon">
			{SHAPES[symbol]}
		</svg>
	);
}
