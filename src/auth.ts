import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { OAuthCredentials, OAuthLoginCallbacks, ProviderAuthInteraction } from "@earendil-works/pi-ai/compat";
import { fetchCatalog, writeCatalogCache } from "./catalog";
import { API_BASE, APP_BASE, normalizeToken } from "./devin";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const CATALOG_PRIME_TIMEOUT_MS = 10_000;
const CALLBACK_CODE = /[?&]code=([^&\s]+)/;

const AUTH_INSTRUCTIONS = "Sign in with the Devin account whose subscription Pi should use.";
const MANUAL_CODE_MESSAGE = "Paste the Devin redirect URL (or the whole callback URL) from the browser";
const EXCHANGING_MESSAGE = "Exchanging authorization code…";
const MANUAL_FALLBACK_MESSAGE = "Waiting for the callback failed; paste the redirect URL instead.";
const CANCELLED_MESSAGE = "Login cancelled";
const TIMEOUT_MESSAGE = "Devin login timed out after 5 minutes";

interface CallbackServer {
	redirectUri: string;
	waitForCode: () => Promise<string>;
	close: () => void;
}

export function base64url(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}

export function pkcePair(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

export function codeFromInput(input: string): string | undefined {
	const value = input.trim();
	if (!value) return undefined;

	if (value.startsWith("http://") || value.startsWith("https://")) {
		try {
			return new URL(value).searchParams.get("code") ?? undefined;
		} catch {
			return undefined;
		}
	}

	const match = CALLBACK_CODE.exec(value);
	return match?.[1] ?? value.split(/\s+/)[0];
}

function authorizeUrl(redirectUri: string, state: string, challenge: string): string {
	const query = new URLSearchParams({
		redirect_uri: redirectUri,
		state,
		prompt: "select_account",
		code_challenge: challenge,
		code_challenge_method: "S256",
		cli_pkce_marker: "1",
	});
	return `${APP_BASE}/auth/cli/continue?${query}`;
}

async function exchangeCode(code: string, verifier: string): Promise<{ token: string; webappHost?: string }> {
	const response = await fetch(`${API_BASE}/auth/cli/token`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "*/*" },
		body: JSON.stringify({ code, code_verifier: verifier }),
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		const suffix = detail ? `: ${detail.slice(0, 200)}` : "";
		throw new Error(`Devin token exchange failed (HTTP ${response.status})${suffix}`);
	}

	const payload = (await response.json()) as { token?: string; webapp_host?: string };
	if (!payload.token) throw new Error("Devin token exchange returned no token");
	return { token: payload.token, webappHost: payload.webapp_host };
}

function callbackPage(title: string, message: string): string {
	return `<h1>Devin - ${title}</h1><p>${message}</p>`;
}

async function startCallbackServer(expectedState: string, signal?: AbortSignal): Promise<CallbackServer> {
	const server = createServer();
	const port = await new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, CALLBACK_HOST, () => {
			const address = server.address();
			if (address && typeof address === "object") resolve(address.port);
			else reject(new Error("Could not bind the Devin login callback"));
		});
	});

	const redirectUri = `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`;

	const waitForCode = () =>
		new Promise<string>((resolve, reject) => {
			const finish = (settle: () => void) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				server.close();
				settle();
			};
			const timer = setTimeout(() => finish(() => reject(new Error(TIMEOUT_MESSAGE))), LOGIN_TIMEOUT_MS);
			const onAbort = () => finish(() => reject(new Error(CANCELLED_MESSAGE)));
			signal?.addEventListener("abort", onAbort, { once: true });

			server.on("request", (request, response) => {
				const url = new URL(request.url ?? "/", redirectUri);
				if (url.pathname !== CALLBACK_PATH) {
					response.writeHead(404).end("Not found");
					return;
				}

				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");
				const returnedState = url.searchParams.get("state");
				response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });

				if (error || !code || returnedState !== expectedState) {
					const reason = error ?? (returnedState !== expectedState ? "State mismatch" : "Missing code");
					response.end(callbackPage("login failed", "Return to Pi and try /login devin again."));
					finish(() => reject(new Error(reason)));
					return;
				}

				response.end(callbackPage("Connected", "You can close this tab and return to Pi."));
				finish(() => resolve(code));
			});
		});

	return { redirectUri, waitForCode, close: () => server.close() };
}

async function receiveCode(callbacks: OAuthLoginCallbacks, server: CallbackServer): Promise<string> {
	try {
		return await server.waitForCode();
	} catch (error) {
		if (callbacks.signal?.aborted) throw new Error(CANCELLED_MESSAGE);
		if (!callbacks.onManualCodeInput) throw error;

		callbacks.onProgress?.(MANUAL_FALLBACK_MESSAGE);
		const pasted = await callbacks.onManualCodeInput();
		const code = codeFromInput(String(pasted ?? ""));
		if (!code) throw new Error("No authorization code provided");
		return code;
	}
}

export async function loginDevin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = pkcePair();
	const state = randomUUID();
	const server = await startCallbackServer(state, callbacks.signal);

	callbacks.onAuth({ url: authorizeUrl(server.redirectUri, state, challenge), instructions: AUTH_INSTRUCTIONS });

	try {
		const code = await receiveCode(callbacks, server);
		callbacks.onProgress?.(EXCHANGING_MESSAGE);
		const { token } = await exchangeCode(code, verifier);
		const primed = await fetchCatalog(normalizeToken(token), AbortSignal.timeout(CATALOG_PRIME_TIMEOUT_MS)).catch(
			() => [],
		);
		if (primed.length > 0) writeCatalogCache(primed);
		return { access: normalizeToken(token), refresh: token, expires: Date.now() + TOKEN_LIFETIME_MS };
	} finally {
		server.close();
	}
}

export function interactionCallbacks(interaction: ProviderAuthInteraction): OAuthLoginCallbacks {
	return {
		signal: interaction.signal,
		onAuth: (info) => interaction.notify({ type: "auth_url", url: info.url, instructions: info.instructions }),
		onProgress: (message) => interaction.notify({ type: "progress", message }),
		onManualCodeInput: () => interaction.prompt({ type: "manual_code", message: MANUAL_CODE_MESSAGE }),
		onDeviceCode: (info) =>
			interaction.notify({
				type: "device_code",
				userCode: info.userCode,
				verificationUri: info.verificationUri,
				openBrowserOnConfirm: info.openBrowserOnConfirm,
				copyCodeOnConfirm: info.copyCodeOnConfirm,
			}),
		onPrompt: (prompt) => interaction.prompt({ type: "text", message: prompt.message, placeholder: prompt.placeholder }),
		onSelect: async (prompt) => {
			const choice = await interaction.prompt({
				type: "select",
				message: prompt.message,
				options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
			});
			return choice || undefined;
		},
	};
}