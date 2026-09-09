/**
 * ask_user - lets the LLM ask the user a question instead of guessing.
 *
 * Step 1 (this version): simple implementation using the built-in
 * ctx.ui.select / ctx.ui.input dialogs. No custom rendering yet.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const OTHER_LABEL = "Something else... (type my own answer)";

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a clarifying question when you are unsure how to proceed, instead of guessing. " +
			"Optionally provide candidate answers; the user can also type their own free-text response.",
		promptSnippet: "Ask the user a clarifying question, optionally with suggested answers",
		promptGuidelines: [
			"Use ask_user when you are uncertain about requirements, scope, or a decision and guessing would risk wasted work; prefer asking over assuming.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask the user" }),
			options: Type.Optional(
				Type.Array(Type.String(), {
					description: "Candidate answers to offer the user, if you have good guesses",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (non-interactive mode); cannot ask user." }],
					details: { question: params.question, answer: null },
				};
			}

			const options = params.options ?? [];
			let answer: string | undefined;

			if (options.length > 0) {
				const choice = await ctx.ui.select(params.question, [...options, OTHER_LABEL]);
				if (choice === undefined) {
					return {
						content: [{ type: "text", text: "User cancelled the question." }],
						details: { question: params.question, answer: null },
					};
				}
				if (choice === OTHER_LABEL) {
					answer = await ctx.ui.input(params.question, "Type your answer...");
				} else {
					answer = choice;
				}
			} else {
				answer = await ctx.ui.input(params.question, "Type your answer...");
			}

			if (answer === undefined || answer.trim() === "") {
				return {
					content: [{ type: "text", text: "User cancelled the question." }],
					details: { question: params.question, answer: null },
				};
			}

			return {
				content: [{ type: "text", text: `User answered: ${answer}` }],
				details: { question: params.question, answer },
			};
		},
	});
}
