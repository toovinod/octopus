import { Predicate } from "effect";

export const errorTag = (error: unknown): string | null =>
	Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? error._tag : null;

// Tagged errors whose message describes the transport or a decoding failure, not something the user can act on.
const RAW_TAGS = new Set(["RpcClientError", "SchemaError"]);

// Daemon and app errors are tagged and carry a message written for the user. Anything else, such as a socket error,
// a decoding failure or a defect, gets a generic one. The raw cause belongs in logs.
export const errorMessage = (error: unknown): string => {
	const tag = errorTag(error);
	return tag !== null &&
		!RAW_TAGS.has(tag) &&
		Predicate.hasProperty(error, "message") &&
		Predicate.isString(error.message) &&
		error.message !== ""
		? error.message
		: "Something went wrong. Try again.";
};
