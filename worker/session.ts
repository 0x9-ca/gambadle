/**
 * Session identity via a signed cookie.
 *
 * The cookie carries `<sessionId>.<hmac>`. It is HttpOnly so the client cannot
 * read or forge it, and the HMAC means a player cannot mint a session id for
 * somebody else's run. The signature is compared in constant time to avoid
 * leaking information through response timing.
 */

const COOKIE_NAME = 'gambadle_sid';
const encoder = new TextEncoder();

/** Verifies and extracts the session id from a signed cookie value. */
export async function verifyCookieValue(
	value: string | undefined,
	secret: string
): Promise<string | null> {
	if (!value) return null;

	const dot = value.lastIndexOf('.');
	if (dot <= 0) return null;

	const sessionId = value.slice(0, dot);
	const providedSig = value.slice(dot + 1);
	if (!/^[0-9a-f]{64}$/.test(providedSig)) return null;
	if (!/^[0-9a-f-]{36}$/.test(sessionId)) return null;

	const expected = await sign(sessionId, secret);
	// Both operands are 32-byte SHA-256 digests, so timingSafeEqual is safe
	// from the length-mismatch throw that raw string comparison would risk.
	if (!timingSafeEqualHex(providedSig, expected)) return null;
	return sessionId;
}

/** Reads the session id from a request's Cookie header, or null if absent/invalid. */
export async function readSession(request: Request, secret: string): Promise<string | null> {
	const header = request.headers.get('Cookie');
	if (!header) return null;

	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		const name = part.slice(0, eq).trim();
		if (name !== COOKIE_NAME) continue;
		return verifyCookieValue(decodeURIComponent(part.slice(eq + 1).trim()), secret);
	}
	return null;
}

export async function newSessionId(): Promise<string> {
	return crypto.randomUUID();
}

/** Builds a fresh signed cookie value for a session id. */
export async function signCookieValue(sessionId: string, secret: string): Promise<string> {
	return `${sessionId}.${await sign(sessionId, secret)}`;
}

/**
 * Set-Cookie value for a session. Secure is omitted in local dev over http so
 * the cookie is actually stored; the deployed custom domain is always https.
 */
export function sessionCookieHeader(value: string, secure: boolean): string {
	const attrs = [
		`${COOKIE_NAME}=${encodeURIComponent(value)}`,
		'Path=/',
		'HttpOnly',
		'SameSite=Lax',
		'Max-Age=43200', // 12 hours; a run cannot outlive a day anyway.
	];
	if (secure) attrs.push('Secure');
	return attrs.join('; ');
}

/** Clears the session cookie. */
export function clearSessionCookieHeader(secure: boolean): string {
	const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
	if (secure) attrs.push('Secure');
	return attrs.join('; ');
}

// ---------------------------------------------------------------------------
// HMAC internals
// ---------------------------------------------------------------------------

async function sign(sessionId: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(sessionId));
	return toHex(new Uint8Array(mac));
}

/**
 * Constant-time comparison of two lowercase hex digests of equal length.
 *
 * Lengths are validated by the caller, so this cannot throw the way
 * `crypto.subtle.timingSafeEqual` would on a length mismatch.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}