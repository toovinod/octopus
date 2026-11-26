import {
	bundledThemes,
	bundledLanguages,
	createBundledHighlighter,
	createSingletonShorthands,
	createJavaScriptRegexEngine,
} from "shiki";

// The JavaScript regex engine, not Oniguruma's WebAssembly, so the desktop shell's CSP can keep refusing
// 'wasm-unsafe-eval'. It cannot run a few grammars' patterns, and forgiving skips those instead of failing the
// whole block.
const { codeToHtml } = createSingletonShorthands(
	createBundledHighlighter({
		langs: bundledLanguages,
		themes: bundledThemes,
		engine: () => createJavaScriptRegexEngine({ forgiving: true }),
	}),
);

// Imported only with import(), so Shiki and its grammars load when a chat first shows a code block, not with the app.
// Both themes are written as CSS variables, and the chat picks one by the app's light or dark class.
export const highlightCode = (code: string, language: string) =>
	codeToHtml(code, {
		lang: Object.hasOwn(bundledLanguages, language) ? language : "text",
		themes: { light: "github-light", dark: "github-dark" },
		defaultColor: false,
	});
