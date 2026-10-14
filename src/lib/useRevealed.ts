import { useEffect, useState } from 'react';

/**
 * False until `seconds` after mount, then true. For things that would give a
 * result away (the verdict, the next bet) and so must wait for the board's reveal.
 *
 * They are not rendered until then, rather than hidden: a hidden panel still
 * takes up its space, which left a tall empty gap under the result board and
 * pushed the board out of view. Reduced motion skips the wait, as the boards
 * skip their animation.
 */
export function useRevealed(seconds: number): boolean {
	const instant = () =>
		seconds <= 0 || (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true);
	const [revealed, setRevealed] = useState(instant);
	useEffect(() => {
		if (revealed) return;
		const timer = setTimeout(() => setRevealed(true), seconds * 1000);
		return () => clearTimeout(timer);
	}, []); // eslint-disable-line react-hooks/exhaustive-deps
	return revealed;
}
