import { createProvider } from "@earendil-works/pi-ai/compat";
import type { OAuthCredential, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { interactionCallbacks, loginDevin } from "./auth";
import { fetchModels, seedModels } from "./catalog";
import { resetSessionState, streamDevin } from "./chat";
import { PROVIDER_ID, UPSTREAM_BASE, normalizeToken } from "./devin";

export default function devinSubscriptionProvider(pi: ExtensionAPI): void {
	pi.on("session_start", resetSessionState);
	pi.on("session_shutdown", resetSessionState);

	const provider = createProvider({
		id: PROVIDER_ID,
		name: "Devin (subscription)",
		baseUrl: UPSTREAM_BASE,
		auth: {
			oauth: {
				name: "Devin",
				isSubscription: true,
				login: async (interaction) => ({ type: "oauth", ...(await loginDevin(interactionCallbacks(interaction))) }),
				refresh: (credential: OAuthCredential) => Promise.resolve(credential),
				toAuth: (credential) => Promise.resolve({ apiKey: normalizeToken(credential.access) }),
			},
		},
		models: seedModels(),
		api: {
			stream: (model, context, options?: StreamOptions) => streamDevin(model, context, options as SimpleStreamOptions),
			streamSimple: streamDevin,
		},
		fetchModels,
	});

	pi.registerProvider(provider);
}
