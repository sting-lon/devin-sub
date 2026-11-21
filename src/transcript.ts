import { randomUUID } from "node:crypto";
import type { ToolCall, TranscriptContext } from "@earendil-works/pi-ai";

export interface DevinImage {
	data: string;
	mimeType: string;
}

export interface DevinToolCallPrompt {
	id: string;
	name: string;
	arguments: string;
}

export const PROMPT_SOURCE_USER = 1;
export const PROMPT_SOURCE_ASSISTANT = 2;
export const PROMPT_SOURCE_TOOL = 4;

type PromptSource = typeof PROMPT_SOURCE_USER | typeof PROMPT_SOURCE_ASSISTANT | typeof PROMPT_SOURCE_TOOL;

export interface DevinPrompt {
	messageId: string;
	source: PromptSource;
	content: string;
	toolCalls?: DevinToolCallPrompt[];
	toolCallId?: string;
	cacheControl?: boolean;
	thinking?: string;
	signature?: string;
	signatureType?: string;
	images?: DevinImage[];
	modelUid?: string;
}

export interface ModelIdentity {
	provider: string;
	id: string;
}

interface PendingCall {
	id: string;
	name: string;
}

interface PromptState {
	pendingCalls: PendingCall[];
}

interface ContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	data?: string;
	mimeType?: string;
	thinkingSignature?: string;
	textSignature?: string;
	thoughtSignature?: string;
}

const signatureTypes = new Map<string, string>();
const GEMINI_MODEL_PATTERN = /^gemini/i;
const GEMINI_SIGNATURE_TYPE = "gemini";
export const DATA_URL_PREFIX = /^data:[^;]+;base64,/;
export const WHITESPACE = /\s+/g;
const EMPTY_TOOL_OUTPUT = "(no output)";
const IMAGE_ONLY_CONTENT = "(image)";
const CONTINUATION_CONTENT = "Continue.";
const ORPHAN_TOOL_PREFIX = "[tool result";

export function clearSignatures(): void {
	signatureTypes.clear();
}

export function rememberSignature(signature: string, type: string | undefined): void {
	if (signature && type) signatureTypes.set(signature, type);
}

export function signatureTypeOf(signature: string, modelId: string): string | undefined {
	return signatureTypes.get(signature) ?? (GEMINI_MODEL_PATTERN.test(modelId) ? GEMINI_SIGNATURE_TYPE : undefined);
}

function contentBlocks(content: unknown): ContentBlock[] {
	if (!Array.isArray(content)) return [];
	return content.filter((block): block is ContentBlock => Boolean(block) && typeof block === "object");
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	let imageIndex = 0;
	return contentBlocks(content)
		.map((block) => {
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "image") {
				imageIndex += 1;
				return `[Image ${imageIndex}]`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function imagesOfContent(content: unknown): DevinImage[] {
	return contentBlocks(content)
		.filter((block) => block.type === "image" && block.data)
		.map((block) => ({ data: block.data as string, mimeType: block.mimeType ?? "image/png" }));
}

function textOfBlocks(content: unknown): string {
	return contentBlocks(content)
		.filter((block) => block.type === "text" && block.text)
		.map((block) => block.text as string)
		.join("\n")
		.trim();
}

function signatureOfBlocks(content: unknown, owner: { provider?: string; model?: string }, from?: ModelIdentity): string | undefined {
	const sameModel = !from || (owner.provider === from.provider && owner.model === from.id);
	if (!sameModel) return undefined;

	let signature: string | undefined;
	for (const block of contentBlocks(content)) {
		if (block.type === "thinking") signature = block.thinkingSignature ?? block.thoughtSignature ?? signature;
		else if (block.type === "text") signature = block.textSignature ?? block.thoughtSignature ?? signature;
		else signature = block.thoughtSignature ?? signature;
	}
	return signature;
}

function newPrompt(source: PromptSource, content: string, extra: Partial<DevinPrompt> = {}): DevinPrompt {
	return { messageId: randomUUID(), source, content, ...extra };
}


function appendUserPrompt(prompts: DevinPrompt[], message: { content?: unknown }): void {
	const content = typeof message.content === "string" ? message.content.trim() : textOfBlocks(message.content);
	const images = imagesOfContent(message.content);
	if (!content && images.length === 0) return;

	const previous = prompts.at(-1);
	if (previous?.source !== PROMPT_SOURCE_USER) {
		prompts.push(newPrompt(PROMPT_SOURCE_USER, content || IMAGE_ONLY_CONTENT, images.length > 0 ? { images } : {}));
		return;
	}
	if (content) previous.content = previous.content ? `${previous.content}

${content}` : content;
	if (images.length > 0) previous.images = [...(previous.images ?? []), ...images];
}

function appendAssistantPrompt(
	prompts: DevinPrompt[],
	message: { content?: unknown; provider?: string; model?: string },
	state: PromptState,
	from?: ModelIdentity,
): void {
	const content = textOfBlocks(message.content);
	const blocks = contentBlocks(message.content);
	const calls: DevinToolCallPrompt[] = blocks
		.filter((block) => block.type === "toolCall")
		.map((block) => {
			const call = block as unknown as ToolCall;
			return { id: call.id, name: call.name, arguments: JSON.stringify(call.arguments ?? {}) };
		});
	if (!content && calls.length === 0) return;

	state.pendingCalls = calls.filter((call) => call.id).map((call) => ({ id: call.id, name: call.name }));

	const signature = signatureOfBlocks(message.content, message, from);
	const signatureType = signature ? signatureTypeOf(signature, from?.id ?? "") : undefined;
	const thinking = blocks
		.filter((block) => block.type === "thinking" && block.thinking)
		.map((block) => block.thinking as string)
		.join("\n");

	prompts.push(
		newPrompt(PROMPT_SOURCE_ASSISTANT, content, {
			toolCalls: calls,
			thinking: thinking || undefined,
			signature: signatureType ? signature : undefined,
			signatureType,
			modelUid: message.model || from?.id || undefined,
		}),
	);
}

function appendToolResultPrompt(
	prompts: DevinPrompt[],
	message: { toolCallId?: string; toolName?: string; content?: unknown },
	state: PromptState,
): void {
	const body = textOfContent(message.content).trim() || EMPTY_TOOL_OUTPUT;
	const images = imagesOfContent(message.content);
	let matchIndex = message.toolCallId
		? state.pendingCalls.findIndex((call) => call.id === message.toolCallId)
		: -1;
	if (matchIndex === -1 && message.toolName) {
		matchIndex = state.pendingCalls.findIndex((call) => call.name === message.toolName);
	}
	const matched = state.pendingCalls.splice(matchIndex === -1 ? 0 : matchIndex, 1)[0];

	if (!matched) {
		const label = message.toolName ? `${ORPHAN_TOOL_PREFIX}: ${message.toolName}]` : `${ORPHAN_TOOL_PREFIX}]`;
		prompts.push(newPrompt(PROMPT_SOURCE_USER, `${label}\n${body}`, images.length > 0 ? { images } : {}));
		return;
	}

	prompts.push(
		newPrompt(PROMPT_SOURCE_TOOL, body, {
			toolCallId: matched.id,
			images: images.length > 0 ? images : undefined,
		}),
	);
}

const MAX_CACHE_BREAKPOINTS = 2;

function applyCacheBreakpoints(prompts: DevinPrompt[]): void {
	let remaining = MAX_CACHE_BREAKPOINTS;
	for (let i = prompts.length - 1; i >= 0 && remaining > 0; i -= 1) {
		const source = prompts[i].source;
		if (source === PROMPT_SOURCE_USER || source === PROMPT_SOURCE_TOOL) {
			prompts[i].cacheControl = true;
			remaining -= 1;
		}
	}
}

type TranscriptMessage = { role?: string; content?: unknown; provider?: string; model?: string; toolCallId?: string; toolName?: string };

export function toPrompts(context: TranscriptContext, from?: ModelIdentity): DevinPrompt[] {
	const prompts: DevinPrompt[] = [];
	const state: PromptState = { pendingCalls: [] };

	for (const message of context.messages as TranscriptMessage[]) {
		if (!message || typeof message !== "object") continue;
		if (message.role === "user") appendUserPrompt(prompts, message);
		else if (message.role === "assistant") appendAssistantPrompt(prompts, message, state, from);
		else if (message.role === "toolResult") appendToolResultPrompt(prompts, message, state);
	}

	const lastSource = prompts.at(-1)?.source;
	if (prompts.length === 0 || lastSource === PROMPT_SOURCE_ASSISTANT) {
		prompts.push(newPrompt(PROMPT_SOURCE_USER, CONTINUATION_CONTENT));
	}

	applyCacheBreakpoints(prompts);
	return prompts;
}
