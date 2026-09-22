import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function actsisLiteLLMExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.notify("pi-actsis-litellm loaded", "info");
		}
	});

	pi.registerCommand("litellm:status", {
		description: "Show LiteLLM gateway status and model cache state",
		handler: async (_args, ctx) => {
			ctx.ui.notify("litellm:status is not implemented yet", "info");
		},
	});

	pi.registerCommand("litellm:models", {
		description: "Force-sync LiteLLM model catalog and show changes",
		handler: async (_args, ctx) => {
			ctx.ui.notify("litellm:models is not implemented yet", "info");
		},
	});

	pi.registerCommand("litellm:logout", {
		description: "Revoke LiteLLM credentials and clear local state",
		handler: async (_args, ctx) => {
			ctx.ui.notify("litellm:logout is not implemented yet", "info");
		},
	});
}
