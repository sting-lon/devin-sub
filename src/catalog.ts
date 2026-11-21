import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Api, Credential, Model, RefreshModelsContext } from "@earendil-works/pi-ai/compat";
import {
	API_ID,
	CATALOG_CACHE_FILE,
	CATALOG_TTL_MS,
	CATALOG_URL,
	EXTENSION_DIR,
	MAX_OUTPUT_TOKENS,
	PROVIDER_ID,
	UPSTREAM_BASE,
	buildClientMetadata,
	normalizeToken,
	pbBytes,
	readFields,
	WIRE_BYTES,
	WIRE_VARINT,
} from "./devin";

export interface CatalogModel {
	uid: string;
	label: string;
	contextWindow: number;
	multimodal: boolean;
}

interface CatalogSnapshot {
	fetchedAt: number;
	models: CatalogModel[];
}

const CatalogField = {
	config: 1,
	label: 1,
	multimodal: 5,
	contextWindow: 18,
	uid: 22,
} as const;

const FALLBACK_CONTEXT_WINDOW = 200_000;

const EFFORT_SUFFIXES = [
	"-medium-fast",
	"-high-fast",
	"-xhigh-fast",
	"-max-fast",
	"-low-fast",
	"-medium-priority",
	"-high-priority",
	"-xhigh-priority",
	"-max-priority",
	"-low-priority",
	"-medium-lightning",
	"-high-lightning",
	"-xhigh-lightning",
	"-max-lightning",
	"-minimal-lightning",
	"-thinking-1m",
	"-max-1m",
	"-none-1m",
	"-medium",
	"-high",
	"-xhigh",
	"-max",
	"-low",
	"-none",
	"-fast",
	"-slow",
	"-priority",
	"-thinking",
	"_medium",
	"_high",
	"_max",
	"_low",
	"_none",
];

const EFFORT_PREFERENCE = ["-medium", "-high", "-low", "-none", "-xhigh", "-max", "-medium-fast", "-high-fast", "-low-fast"];

const EFFORT_BY_THINKING_LEVEL: Record<string, string> = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const EFFORT_WORDS = /\b(none|minimal|low|medium|high|xhigh|max|thinking|fast|priority|lightning)\b/gi;

export function familyKey(uid: string): string {
	const suffix = EFFORT_SUFFIXES.find((candidate) => uid.endsWith(candidate) && uid.length > candidate.length);
	return suffix ? uid.slice(0, -suffix.length) : uid;
}

function effortRank(uid: string): number {
	const index = EFFORT_PREFERENCE.findIndex((suffix) => uid.endsWith(suffix));
	return index === -1 ? EFFORT_PREFERENCE.length : index;
}

export function collapseFamilies(models: CatalogModel[]): CatalogModel[] {
	const bestPerFamily = new Map<string, CatalogModel>();
	for (const model of models) {
		if (!model.uid) continue;
		const key = familyKey(model.uid);
		const current = bestPerFamily.get(key);
		if (!current || effortRank(model.uid) < effortRank(current.uid)) bestPerFamily.set(key, model);
	}
	return [...bestPerFamily.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export function familyLabel(label: string): string {
	const cleaned = label.replace(EFFORT_WORDS, " ").replace(/\s+/g, " ").trim();
	return cleaned || label;
}

export function parseCatalog(buffer: Buffer): CatalogModel[] {
	const models: CatalogModel[] = [];
	for (const field of readFields(buffer)) {
		if (field.field !== CatalogField.config || field.wire !== WIRE_BYTES) continue;
		const model: CatalogModel = { uid: "", label: "", contextWindow: FALLBACK_CONTEXT_WINDOW, multimodal: false };
		for (const entry of readFields(field.value as Buffer)) {
			if (entry.wire === WIRE_BYTES && entry.field === CatalogField.label) {
				model.label = (entry.value as Buffer).toString("utf8");
			} else if (entry.wire === WIRE_BYTES && entry.field === CatalogField.uid) {
				model.uid = (entry.value as Buffer).toString("utf8");
			} else if (entry.wire === WIRE_VARINT && entry.field === CatalogField.multimodal) {
				model.multimodal = Number(entry.value as bigint) === 1;
			} else if (entry.wire === WIRE_VARINT && entry.field === CatalogField.contextWindow) {
				model.contextWindow = Number(entry.value as bigint) || FALLBACK_CONTEXT_WINDOW;
			}
		}
		if (model.uid) models.push(model);
	}
	return models;
}

let catalogInFlight: Promise<CatalogModel[]> | undefined;

export async function fetchCatalog(token: string, signal?: AbortSignal): Promise<CatalogModel[]> {
	if (catalogInFlight !== undefined) return catalogInFlight;
	catalogInFlight = (async () => {
		const response = await fetch(CATALOG_URL, {
			method: "POST",
			headers: {
				Authorization: `Basic ${token}-${token}`,
				"Content-Type": "application/proto",
				"Connect-Protocol-Version": "1",
			},
			body: new Uint8Array(pbBytes(1, buildClientMetadata(token))),
			signal,
		});
		if (!response.ok) throw new Error(`Devin catalog request failed (HTTP ${response.status})`);
		return parseCatalog(Buffer.from(await response.arrayBuffer()));
	})().finally(() => {
		catalogInFlight = undefined;
	});
	return catalogInFlight;
}

export function readCatalogCache(): CatalogSnapshot | undefined {
	try {
		if (!existsSync(CATALOG_CACHE_FILE)) return undefined;
		const parsed = JSON.parse(readFileSync(CATALOG_CACHE_FILE, "utf8")) as Partial<CatalogSnapshot>;
		if (!parsed.models?.length) return undefined;
		return { fetchedAt: parsed.fetchedAt ?? 0, models: parsed.models };
	} catch {
		return undefined;
	}
}

export function writeCatalogCache(models: CatalogModel[]): void {
	try {
		if (!existsSync(EXTENSION_DIR)) mkdirSync(EXTENSION_DIR, { recursive: true });
		writeFileSync(CATALOG_CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), models }));
		knownUids = undefined;
	} catch {
		return;
	}
}

export function toModels(models: CatalogModel[]): Model<Api>[] {
	return models.map((model) => ({
		id: model.uid,
		name: familyLabel(model.label || model.uid),
		api: API_ID as Api,
		provider: PROVIDER_ID,
		baseUrl: UPSTREAM_BASE,
		reasoning: true,
		input: (model.multimodal ? ["text", "image"] : ["text"]) as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: Math.min(MAX_OUTPUT_TOKENS, model.contextWindow),
	}));
}

export function seedModels(): Model<Api>[] {
	return toModels(collapseFamilies(readCatalogCache()?.models ?? []));
}

export async function fetchModels(context: RefreshModelsContext): Promise<readonly Model<Api>[]> {
	const cached = readCatalogCache();
	if (cached && !context.force && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
		return toModels(collapseFamilies(cached.models));
	}

	const token = tokenOfCredential(context.credential);
	if (!token) throw new Error("Not logged in to Devin. Run /login devin.");
	if (context.signal.aborted) return [];

	const models = await fetchCatalog(token, context.signal);
	if (context.signal.aborted) return seedModels();
	if (models.length === 0) {
		return seedModels();
	}

	writeCatalogCache(models);
	return toModels(collapseFamilies(models));
}

export function tokenOfCredential(credential?: Credential): string | undefined {
	if (!credential) return undefined;
	const raw = credential.type === "oauth" ? credential.access : credential.key;
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	return normalizeToken(raw);
}

let knownUids: Set<string> | undefined;

export function resolveModelUid(modelId: string, thinkingLevel?: string): string {
	const effort = EFFORT_BY_THINKING_LEVEL[(thinkingLevel ?? "").toLowerCase()];
	if (!effort) return modelId;

	knownUids ??= new Set((readCatalogCache()?.models ?? []).map((model) => model.uid));
	if (knownUids.size === 0) return modelId;

	const base = familyKey(modelId);
	const candidates = effort === "none" ? [base, `${base}-none`] : [`${base}-${effort}`];
	return candidates.find((candidate) => knownUids?.has(candidate)) ?? modelId;
}
