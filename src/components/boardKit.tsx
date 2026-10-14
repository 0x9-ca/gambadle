/**
 * Pieces the game boards share: reduced-motion detection, the timers that cycle
 * placeholder faces while a result is on its way, the button row, a quiet note,
 * and the drawn die. Kept apart from boards.tsx so a board in its own file can
 * use them without importing the file that imports it.
 */

import { useEffect, useState, type ReactNode } from 'react';

export const prefersReducedMotion = (): boolean =>
	typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** True for `ms` after mount when `enabled`, never under reduced motion. */
export function useRollOnMount(enabled: boolean, ms: number): boolean {
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
export function useTick(active: boolean, ms = 90): number {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setTick((t) => t + 1), ms);
		return () => clearInterval(timer);
	}, [active, ms]);
	return tick;
}

export function Actions({ children }: { children: ReactNode }) {
	return <div className="btn-row">{children}</div>;
}

export function Note({ children }: { children: ReactNode }) {
	return (
		<p className="faint" style={{ margin: 0 }}>
			{children}
		</p>
	);
}

/** Pip positions on a 3×3 grid, numbered 0-8 left to right, top to bottom. */
const PIPS: Record<number, number[]> = {
	1: [4],
	2: [2, 6],
	3: [2, 4, 6],
	4: [0, 2, 6, 8],
	5: [0, 2, 4, 6, 8],
	6: [0, 2, 3, 5, 6, 8],
};

export function Die({ face, rolling, blank }: { face: number; rolling: boolean; blank?: boolean }) {
	return (
		<span className={`die${rolling ? ' die--rolling' : ''}${blank ? ' die--blank' : ''}`} role="img" aria-label={blank ? 'Die' : `Die showing ${face}`}>
			{Array.from({ length: 9 }, (_, i) => (
				<span key={i} className={PIPS[face]?.includes(i) ? 'die__pip' : 'die__slot'} />
			))}
		</span>
	);
}
