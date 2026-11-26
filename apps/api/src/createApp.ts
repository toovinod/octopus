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
		.get("/health", (context) => context.json({ status: "ok" }))
		.on(["GET", "POST"], "/api/auth/*", (context) => authHandler(context.req.raw));
