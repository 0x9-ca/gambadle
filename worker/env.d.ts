/** Vars set only in some wrangler environments, so the generated Env lacks them. */
interface Env {
	/** '1' on the staging deployment, which plays practice runs instead of ranked ones. */
	STAGING?: string;
}
