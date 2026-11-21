import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Api, Credential, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import {
	API_ID,
	CATALOG_CACHE_FILE,
	CATALOG_TTL_MS,
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
	maxOutputTokens?: number;
	familySlug?: string;
	familyName?: string;
	effort?: string;
	thinking?: boolean;
	fastMode?: boolean;
	context1m?: boolean;
	isDefault?: boolean;
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
	spec: 23,
	familyInfo: 30,
} as const;

const ModelSpecField = {
	contextWindow: 4,
	maxOutputTokens: 13,
	familySlug: 23,
} as const;

const FamilyInfoField = {
	name: 1,
	attribute: 2,
	isDefault: 3,
} as const;

const FamilyAttributeField = {
	name: 1,
	value: 2,
} as const;

const FamilyAttributeValueField = {
	enabled: 1,
	label: 2,
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

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const EFFORT_WORDS = /\b(none|minimal|low|medium|high|xhigh|max|thinking|fast|priority|lightning)\b/gi;

function isFusionModel(uid: string): boolean {
	return uid.startsWith("fusion-");
}

export function familyKey(uid: string): string {
	const suffix = EFFORT_SUFFIXES.find((candidate) => uid.endsWith(candidate) && uid.length > candidate.length);
	return suffix ? uid.slice(0, -suffix.length) : uid;
}

function modelFamilyKey(model: CatalogModel): string {
	return model.familySlug || familyKey(model.uid);
}

function effortRank(uid: string): number {
	const index = EFFORT_PREFERENCE.findIndex((suffix) => uid.endsWith(suffix));
	return index === -1 ? EFFORT_PREFERENCE.length : index;
}

function isBetterFamilyRepresentative(candidate: CatalogModel, current: CatalogModel): boolean {
	if (Boolean(candidate.isDefault) !== Boolean(current.isDefault)) return Boolean(candidate.isDefault);
	if (Boolean(candidate.fastMode) !== Boolean(current.fastMode)) return !candidate.fastMode;
	if (Boolean(candidate.context1m) !== Boolean(current.context1m)) return !candidate.context1m;
	return effortRank(candidate.uid) < effortRank(current.uid);
}

export function collapseFamilies(models: CatalogModel[]): CatalogModel[] {
	const nonFusion = models.filter((model) => model.uid && !isFusionModel(model.uid));
	const pool = nonFusion.length > 0 ? nonFusion : models;
	const bestPerFamily = new Map<string, CatalogModel>();
	for (const model of pool) {
		if (!model.uid) continue;
		const key = modelFamilyKey(model);
		const current = bestPerFamily.get(key);
		if (!current || isBetterFamilyRepresentative(model, current)) bestPerFamily.set(key, model);
	}
	return [...bestPerFamily.values()].sort((left, right) =>
		(left.familyName || left.label).localeCompare(right.familyName || right.label),
	);
}

export function familyLabel(label: string): string {
	const cleaned = label.replace(EFFORT_WORDS, " ").replace(/\s+/g, " ").trim();
	return cleaned || label;
}

function normalizeEffortLabel(raw: string): string | undefined {
	const value = raw.trim().toLowerCase();
	if (value === "no thinking" || value === "off" || value === "none") return "none";
	if (EFFORT_ORDER.includes(value as (typeof EFFORT_ORDER)[number])) return value;
	return undefined;
}

function parseModelSpec(buffer: Buffer, model: CatalogModel): void {
	for (const entry of readFields(buffer)) {
		if (entry.wire === WIRE_VARINT && entry.field === ModelSpecField.contextWindow) {
			const ctx = Number(entry.value as bigint);
			if (ctx > 0 && model.contextWindow === FALLBACK_CONTEXT_WINDOW) model.contextWindow = ctx;
		} else if (entry.wire === WIRE_VARINT && entry.field === ModelSpecField.maxOutputTokens) {
			const maxOut = Number(entry.value as bigint);
			if (maxOut > 0) model.maxOutputTokens = maxOut;
		} else if (entry.wire === WIRE_BYTES && entry.field === ModelSpecField.familySlug) {
			const slug = (entry.value as Buffer).toString("utf8");
			if (slug) model.familySlug = slug;
		}
	}
}

function parseFamilyInfo(buffer: Buffer, model: CatalogModel): void {
	for (const entry of readFields(buffer)) {
		if (entry.wire === WIRE_BYTES && entry.field === FamilyInfoField.name) {
			const name = (entry.value as Buffer).toString("utf8");
			if (name) model.familyName = name;
		} else if (entry.wire === WIRE_VARINT && entry.field === FamilyInfoField.isDefault) {
			if (Number(entry.value as bigint) === 1) model.isDefault = true;
		} else if (entry.wire === WIRE_BYTES && entry.field === FamilyInfoField.attribute) {
			let attrName = "";
			let attrValueBuf: Buffer | undefined;
			for (const attr of readFields(entry.value as Buffer)) {
				if (attr.wire === WIRE_BYTES && attr.field === FamilyAttributeField.name) {
					attrName = (attr.value as Buffer).toString("utf8");
				} else if (attr.wire === WIRE_BYTES && attr.field === FamilyAttributeField.value) {
					attrValueBuf = attr.value as Buffer;
				}
			}
			if (!attrName || !attrValueBuf) continue;
			let enabled: number | undefined;
			let valueLabel: string | undefined;
			for (const val of readFields(attrValueBuf)) {
				if (val.wire === WIRE_VARINT && val.field === FamilyAttributeValueField.enabled) {
					enabled = Number(val.value as bigint);
				} else if (val.wire === WIRE_BYTES && val.field === FamilyAttributeValueField.label) {
					valueLabel = (val.value as Buffer).toString("utf8");
				}
			}
			const lower = attrName.toLowerCase();
			if (lower === "reasoning effort" || lower === "effort") {
				const effort = valueLabel ? normalizeEffortLabel(valueLabel) : undefined;
				if (effort) model.effort = effort;
			} else if (lower === "thinking") {
				model.thinking = enabled === 1;
			} else if (lower === "fast mode") {
				model.fastMode = enabled === 1;
			} else if (lower === "1m context") {
				model.context1m = enabled === 1;
			}
		}
	}
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
			} else if (entry.wire === WIRE_BYTES && entry.field === CatalogField.spec) {
				parseModelSpec(entry.value as Buffer, model);
			} else if (entry.wire === WIRE_BYTES && entry.field === CatalogField.familyInfo) {
				parseFamilyInfo(entry.value as Buffer, model);
			}
		}
		if (model.uid) models.push(model);
	}
	return models;
}

let catalogInFlight: Promise<CatalogModel[]> | undefined;

const CATALOG_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";

export async function fetchCatalog(token: string, signal?: AbortSignal, baseUrl?: string): Promise<CatalogModel[]> {
	if (catalogInFlight !== undefined) return catalogInFlight;
	const url = `${(baseUrl || UPSTREAM_BASE).replace(/\/+$/, "")}${CATALOG_PATH}`;
	catalogInFlight = (async () => {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Basic ${token}-${token}`,
				"Content-Type": "application/proto",
				"Connect-Protocol-Version": "1",
				"Accept-Encoding": "gzip",
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
		cachedIndex = undefined;
	} catch {
		return;
	}
}

function supportsPromptCache(uid: string): boolean {
	return /^claude-/i.test(uid);
}

export function toModels(models: CatalogModel[], allModels?: CatalogModel[]): Model<Api>[] {
	const reasoningFamilies = new Set<string>();
	if (allModels) {
		for (const m of allModels) {
			if (m.effort !== undefined || m.thinking === true) reasoningFamilies.add(modelFamilyKey(m));
		}
	}
	return models.map((model) => {
		const maxOutput = model.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
		const family = modelFamilyKey(model);
		const hasRichMetadata = model.familySlug !== undefined || model.familyName !== undefined;
		const reasoning = allModels && hasRichMetadata ? reasoningFamilies.has(family) : true;
		return {
			type: "chat",
			id: model.uid,
			name: model.familyName || familyLabel(model.label || model.uid),
			api: API_ID as Api,
			provider: PROVIDER_ID,
			baseUrl: UPSTREAM_BASE,
			reasoning,
			...(supportsPromptCache(model.uid) ? { promptCache: { short: 300 } } : {}),
			input: (model.multimodal ? ["text", "image"] : ["text"]) as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: model.contextWindow,
			maxTokens: Math.min(maxOutput, model.contextWindow),
		};
	});
}

export function seedModels(): Model<Api>[] {
	const all = readCatalogCache()?.models ?? [];
	return toModels(collapseFamilies(all), all);
}

export async function fetchModels(context: RefreshModelsContext): Promise<readonly Model<Api>[]> {
	const cached = readCatalogCache();
	if (!context.allowNetwork) {
		const all = cached?.models ?? [];
		return toModels(collapseFamilies(all), all);
	}
	if (cached && !context.force && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
		return toModels(collapseFamilies(cached.models), cached.models);
	}

	const token = tokenOfCredential(context.credential);
	if (!token) throw new Error("Not logged in to Devin. Run /login devin.");
	if (context.signal.aborted) return [];

	const models = await fetchCatalog(token, context.signal, context.baseUrl);
	if (context.signal.aborted) return seedModels();
	if (models.length === 0) {
		return seedModels();
	}

	writeCatalogCache(models);
	return toModels(collapseFamilies(models), models);
}

export function tokenOfCredential(credential?: Credential): string | undefined {
	if (!credential) return undefined;
	const raw = credential.type === "oauth" ? credential.access : credential.key;
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	return normalizeToken(raw);
}

interface CatalogIndex {
	byUid: Map<string, CatalogModel>;
	byFamily: Map<string, CatalogModel[]>;
}

let cachedIndex: CatalogIndex | undefined;

function getCatalogIndex(): CatalogIndex {
	if (cachedIndex) return cachedIndex;
	const byUid = new Map<string, CatalogModel>();
	const byFamily = new Map<string, CatalogModel[]>();
	for (const model of readCatalogCache()?.models ?? []) {
		if (!model.uid) continue;
		byUid.set(model.uid, model);
		const key = modelFamilyKey(model);
		const group = byFamily.get(key);
		if (group) group.push(model);
		else byFamily.set(key, [model]);
	}
	cachedIndex = { byUid, byFamily };
	return cachedIndex;
}

function effortDistance(a: string, b: string): number {
	const ia = EFFORT_ORDER.indexOf(a as (typeof EFFORT_ORDER)[number]);
	const ib = EFFORT_ORDER.indexOf(b as (typeof EFFORT_ORDER)[number]);
	if (ia === -1 || ib === -1) return Number.POSITIVE_INFINITY;
	return Math.abs(ia - ib);
}

export function resolveModelUid(modelId: string, thinkingLevel?: string): string {
	const effort = EFFORT_BY_THINKING_LEVEL[(thinkingLevel ?? "").toLowerCase()];
	if (!effort) return modelId;

	const { byUid, byFamily } = getCatalogIndex();
	if (byUid.size === 0) return modelId;

	const current = byUid.get(modelId);
	const family = byFamily.get(current ? modelFamilyKey(current) : familyKey(modelId));
	if (family && family.length > 1) {
		const sameTier = family.filter(
			(candidate) =>
				Boolean(candidate.fastMode) === Boolean(current?.fastMode) &&
				Boolean(candidate.context1m) === Boolean(current?.context1m),
		);
		let candidates = sameTier.length > 0 ? sameTier : family;

		const hasThinkingToggle = candidates.some((candidate) => candidate.thinking !== undefined);
		if (hasThinkingToggle) {
			const wantThinking = effort !== "none";
			const toggled = candidates.filter((candidate) => Boolean(candidate.thinking) === wantThinking);
			if (toggled.length > 0) candidates = toggled;
		}

		const exactEffort = candidates.find((candidate) => candidate.effort === effort);
		if (exactEffort) return exactEffort.uid;

		const withEffort = candidates.filter((candidate) => candidate.effort !== undefined);
		if (withEffort.length > 0) {
			let best = withEffort[0];
			let bestDist = effortDistance(best.effort!, effort);
			for (let i = 1; i < withEffort.length; i += 1) {
				const dist = effortDistance(withEffort[i].effort!, effort);
				if (dist < bestDist) {
					best = withEffort[i];
					bestDist = dist;
				}
			}
			return best.uid;
		}

		if (candidates.length === 1) return candidates[0].uid;
	}

	const base = familyKey(modelId);
	const fallbackCandidates =
		effort === "none" ? [base, `${base}-none`] : [`${base}-${effort}`, `${base}-thinking`];
	return fallbackCandidates.find((candidate) => byUid.has(candidate)) ?? modelId;
}
