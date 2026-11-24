import { bundledLanguages, codeToHtml } from "shiki";

// Imported only with import(), so Shiki and its grammars load when a chat first shows a code block, not with the app.
// Both themes are written as CSS variables, and the chat picks one by the app's light or dark class.
export const highlightCode = (code: string, language: string) =>
	codeToHtml(code, {
		lang: Object.hasOwn(bundledLanguages, language) ? language : "text",
		themes: { light: "github-light", dark: "github-dark" },
		defaultColor: false,
	});
