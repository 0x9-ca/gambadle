/** The leaderboard name is remembered on this device so it is only typed once. */
const KEY = 'gambadle:name';

export function loadName(): string {
	try {
		return localStorage.getItem(KEY) ?? '';
	} catch {
		// Storage can be blocked (private mode); the form just starts empty.
		return '';
	}
}

export function saveName(name: string): void {
	try {
		localStorage.setItem(KEY, name);
	} catch {
		// Not being able to remember the name is not worth surfacing.
	}
}
