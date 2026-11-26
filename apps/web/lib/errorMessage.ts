import { Predicate } from "effect";

export const errorTag = (error: unknown): string | null =>
	Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? error._tag : null;

// Tagged errors whose message describes a decoding failure, not something the user can act on.
const RAW_TAGS = new Set(["SchemaError"]);

// Daemon and app errors are tagged and carry a message written for the user. A dropped socket says so, since
// the user can wait for the reconnect. Anything else, such as a decoding failure or a defect, gets a generic message.
// The raw cause belongs in logs.
export const errorMessage = (error: unknown): string => {
	const tag = errorTag(error);
	if (tag === "RpcClientError") return "Octopus lost the connection to its daemon. Try again once it reconnects.";
	return tag !== null &&
		!RAW_TAGS.has(tag) &&
		Predicate.hasProperty(error, "message") &&
		Predicate.isString(error.message) &&
		error.message !== ""
		? error.message
		: "Something went wrong. Try again.";
};

// What the screen a failed start shows. Nothing reconnects there, so a dropped socket does not say to wait for it.
export const bootErrorMessage = (error: unknown): string =>
	errorTag(error) === "RpcClientError"
		? "Octopus could not connect to its daemon. Retry, or quit Octopus and open it again."
		: errorMessage(error);

// Only a dropped socket is worth retrying. A daemon error would fail the same way again.
export const isConnectionDrop = (error: unknown) => errorTag(error) === "RpcClientError";
