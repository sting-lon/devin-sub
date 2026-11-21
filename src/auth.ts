import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { fetchCatalog, writeCatalogCache } from "./catalog";
import { API_BASE, APP_BASE, normalizeToken } from "./devin";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const CATALOG_PRIME_TIMEOUT_MS = 10_000;
const CALLBACK_CODE = /[?&]code=([^&\s]+)/;

const AUTH_INSTRUCTIONS = "Sign in with the Devin account whose subscription Pi should use.";
const MANUAL_CODE_MESSAGE = "Paste the Devin redirect URL from the browser.";
const EXCHANGING_MESSAGE = "Exchanging authorization code...";
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

async function exchangeCode(
	code: string,
	verifier: string,
	signal?: AbortSignal,
): Promise<{ token: string; webappHost?: string }> {
	const response = await fetch(`${API_BASE}/auth/cli/token`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "*/*" },
		body: JSON.stringify({ code, code_verifier: verifier }),
		signal,
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

let cachedLogoMarkup: string | undefined;

function devinLogoMarkup(): string {
	if (cachedLogoMarkup !== undefined) return cachedLogoMarkup;
	try {
		const png = readFileSync(new URL("../assets/devin-logo-white.png", import.meta.url));
		cachedLogoMarkup = `<img class="logo" src="data:image/png;base64,${png.toString("base64")}" alt="Devin" />`;
	} catch {
		cachedLogoMarkup =
			`<div class="logo" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">` +
			`<rect width="64" height="64" rx="16" fill="#18181b"/>` +
			`<path d="M20 18h13c9.4 0 16 6.1 16 14s-6.6 14-16 14H20V18zm7 6v16h6c5.4 0 9-3.3 9-8s-3.6-8-9-8h-6z" fill="#fafafa"/>` +
			`</svg></div>`;
	}
	return cachedLogoMarkup;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function callbackPage(title: string, message: string, details?: string): string {
	const safeTitle = escapeHtml(title);
	const safeMessage = escapeHtml(message);
	const detailsBlock = details ? `<div class="details">${escapeHtml(details)}</div>` : "";
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle} - Devin</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .logo {
      width: 72px;
      height: 72px;
      display: block;
      object-fit: contain;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 650;
      color: var(--text);
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    ${devinLogoMarkup()}
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    ${detailsBlock}
  </main>
</body>
</html>`;
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
					response.end(callbackPage("Authentication failed", "Return to Pi and run /login devin again.", reason));
					finish(() => reject(new Error(reason)));
					return;
				}

				response.end(
					callbackPage("Authentication successful", "Signed in to Devin for Pi. You can close this tab and return to Pi."),
				);
				finish(() => resolve(code));
			});
		});

	return { redirectUri, waitForCode, close: () => server.close() };
}

async function receiveCode(interaction: ProviderAuthInteraction, server: CallbackServer): Promise<string> {
	try {
		return await server.waitForCode();
	} catch (error) {
		if (interaction.signal.aborted) throw new Error(CANCELLED_MESSAGE);

		interaction.notify({ type: "progress", message: MANUAL_FALLBACK_MESSAGE });
		const pasted = await interaction.prompt({
			type: "manual_code",
			message: MANUAL_CODE_MESSAGE,
			signal: interaction.signal,
		});
		const code = codeFromInput(String(pasted ?? ""));
		if (!code) throw new Error("No authorization code provided");
		return code;
	}
}

export async function loginDevin(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	interaction.signal.throwIfAborted();
	const { verifier, challenge } = pkcePair();
	const state = randomUUID();
	const server = await startCallbackServer(state, interaction.signal);

	interaction.notify({
		type: "auth_url",
		url: authorizeUrl(server.redirectUri, state, challenge),
		instructions: AUTH_INSTRUCTIONS,
	});

	try {
		const code = await receiveCode(interaction, server);
		interaction.notify({ type: "progress", message: EXCHANGING_MESSAGE });
		const { token } = await exchangeCode(code, verifier, interaction.signal);
		const normalized = normalizeToken(token);
		const primed = await fetchCatalog(
			normalized,
			AbortSignal.any([interaction.signal, AbortSignal.timeout(CATALOG_PRIME_TIMEOUT_MS)]),
		).catch(() => []);
		if (primed.length > 0) writeCatalogCache(primed);
		return { type: "oauth", access: normalized, refresh: token, expires: Date.now() + TOKEN_LIFETIME_MS };
	} finally {
		server.close();
	}
}