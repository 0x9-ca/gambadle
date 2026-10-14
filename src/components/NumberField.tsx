/**
 * A whole-number box for chip amounts.
 *
 * Holds its own draft text so the player can clear it and type freely; the
 * value is only clamped to [min, max] and reported once it parses, and the box
 * snaps back to the committed value when it loses focus.
 */

import { useEffect, useState } from 'react';

export function NumberField({
	value,
	min,
	max,
	onChange,
	label,
	className = '',
	disabled = false,
}: {
	value: number;
	min: number;
	max: number;
	onChange: (value: number) => void;
	/** Accessible name; the box has no visible label of its own. */
	label: string;
	className?: string;
	disabled?: boolean;
}) {
	const [draft, setDraft] = useState(String(value));
	const [focused, setFocused] = useState(false);

	// Follow outside changes (a slider, a quick-bet button) unless mid-edit.
	useEffect(() => {
		if (!focused) setDraft(String(value));
	}, [value, focused]);

	const clamp = (n: number) => Math.min(Math.max(n, min), Math.max(min, max));

	return (
		<input
			type="text"
			inputMode="numeric"
			pattern="[0-9]*"
			enterKeyHint="done"
			className={`num-input ${className}`}
			aria-label={label}
			disabled={disabled}
			value={draft}
			onFocus={(event) => {
				setFocused(true);
				event.target.select();
			}}
			onChange={(event) => {
				const text = event.target.value.replace(/[^0-9]/g, '');
				setDraft(text);
				if (text !== '') onChange(clamp(Number(text)));
			}}
			onBlur={() => {
				setFocused(false);
				setDraft(String(value));
			}}
			onKeyDown={(event) => {
				if (event.key === 'Enter') event.currentTarget.blur();
			}}
		/>
	);
}
