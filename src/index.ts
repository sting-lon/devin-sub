import { createProvider } from "@earendil-works/pi-ai";
import type { OAuthCredential, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loginDevin } from "./auth";
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
				loginLabel: "Sign in with Devin",
				isSubscription: true,
				login: loginDevin,
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
