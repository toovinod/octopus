import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { Hono } from "hono";

export interface CreateAppInput {
	readonly webOrigin: string;
	readonly authHandler: (request: Request) => Promise<Response>;
}

export const createApp = ({ webOrigin, authHandler }: CreateAppInput) =>
	new Hono()
		.use(
			"*",
			cors({
				origin: (origin) => (origin === webOrigin ? origin : null),
				credentials: true,
				allowHeaders: ["Content-Type", "Authorization"],
				allowMethods: ["GET", "POST", "OPTIONS"],
			}),
		)
		// A browser sends a cross-site form post with the user's cookies and no CORS preflight, so CORS
		// alone does not stop it. Better Auth checks its own routes; this covers every other route too.
		.use("*", csrf({ origin: webOrigin }))
		// A route that acts on an org must check that the user is a member of it right then. The session's
		// activeOrganizationId has no foreign key and can name an org the user has left or that was deleted,
		// so it only says which org the user last picked.
		.get("/health", (context) => context.json({ status: "ok" }))
		.on(["GET", "POST"], "/api/auth/*", (context) => authHandler(context.req.raw));
