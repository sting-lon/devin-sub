import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
	ToolCall,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	collapseSystemMessages,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
} from "@earendil-works/pi-ai";
import { resolveModelUid } from "./catalog";
import {
	type DevinPrompt,
	DATA_URL_PREFIX,
	PROMPT_SOURCE_USER,
	WHITESPACE,
	clearSignatures,
	rememberSignature,
	toPrompts,
} from "./transcript";
import {
	CONNECT_END_STREAM_FLAG,
	CONNECT_GZIP_FLAG,
	DEFAULT_MAX_TOKENS,
	UPSTREAM_BASE,
	buildClientMetadata,
	normalizeToken,
	parseConnectTrailer,
	pbBytes,
	pbDouble,
	pbString,
	pbVarint,
	readConnectFrame,
	readFields,
	WIRE_BYTES,
	WIRE_VARINT,
	sentryTrace,
	wrapConnectFrame,
} from "./devin";

const CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";

const PromptField = {
	messageId: 1,
	source: 2,
	content: 3,
	toolCalls: 6,
	toolCallId: 7,
	cacheControl: 8,
	images: 10,
	thinking: 11,
	signature: 12,
	signatureType: 18,
	modelUid: 22,
} as const;

const CACHE_CONTROL_EPHEMERAL = pbVarint(1, 1);

const ToolCallPromptField = { id: 1, name: 2, arguments: 3 } as const;
const ImageField = { data: 1, mimeType: 2 } as const;

const RequestField = {
	metadata: 1,
	systemPrompt: 2,
	prompts: 3,
	flags: 7,
	sampling: 8,
	tools: 10,
	thread: 15,
	cascadeId: 16,
	enabled: 20,
	modelUid: 21,
	sessionUuid: 22,
} as const;

const ToolDefinitionField = { name: 1, description: 2, parameters: 3 } as const;
const ThreadField = { sessionId: 1, turnIndex: 2, marker: 3, userTurnBoundary: 4 } as const;

const Sampling = { flag: 1, maxTokens: 2, reservedTokens: 3, temperature: 5, topK: 7, topP: 8 } as const;
const SAMPLING_DEFAULTS = { flag: 1, reservedTokens: 400, topK: 40, topP: 0.95, temperature: 1 } as const;

const REQUEST_FLAG_VALUE = 5;
const REQUEST_ENABLED_VALUE = 1;
const THREAD_MARKER_VALUE = 4;
const USER_TURN_BOUNDARY_VALUE = 14;
const DEFAULT_IMAGE_MIME_TYPE = "image/png";

interface DevinToolDefinition {
	name: string;
	description: string;
	parametersJson: string;
}

interface ChatRequest {
	token: string;
	modelUid: string;
	systemPrompt: string;
	prompts: DevinPrompt[];
	tools: DevinToolDefinition[];
	threadId: string;
	cascadeId: string;
	sessionUuid: string;
	turnIndex: number;
	maxTokens: number;
	temperature?: number;
	topP?: number;
	topK?: number;
}

function encodePrompt(prompt: DevinPrompt): Buffer {
	const parts: Buffer[] = [
		pbString(PromptField.messageId, prompt.messageId),
		pbVarint(PromptField.source, prompt.source),
	];
	if (prompt.content) parts.push(pbString(PromptField.content, prompt.content));

	for (const call of prompt.toolCalls ?? []) {
		const encoded = Buffer.concat([
			call.id ? pbString(ToolCallPromptField.id, call.id) : Buffer.alloc(0),
			call.name ? pbString(ToolCallPromptField.name, call.name) : Buffer.alloc(0),
			call.arguments ? pbString(ToolCallPromptField.arguments, call.arguments) : Buffer.alloc(0),
		]);
		parts.push(pbBytes(PromptField.toolCalls, encoded));
	}

	if (prompt.toolCallId) parts.push(pbString(PromptField.toolCallId, prompt.toolCallId));
	if (prompt.cacheControl) parts.push(pbBytes(PromptField.cacheControl, CACHE_CONTROL_EPHEMERAL));

	for (const image of prompt.images ?? []) {
		const data = image.data.replace(DATA_URL_PREFIX, "").replace(WHITESPACE, "");
		if (!data) continue;
		const encoded = Buffer.concat([
			pbString(ImageField.data, data),
			pbString(ImageField.mimeType, image.mimeType || DEFAULT_IMAGE_MIME_TYPE),
		]);
		parts.push(pbBytes(PromptField.images, encoded));
	}

	if (prompt.thinking) parts.push(pbString(PromptField.thinking, prompt.thinking));
	if (prompt.signature) parts.push(pbString(PromptField.signature, prompt.signature));
	if (prompt.signatureType) parts.push(pbString(PromptField.signatureType, prompt.signatureType));
	if (prompt.modelUid) parts.push(pbString(PromptField.modelUid, prompt.modelUid));

	return Buffer.concat(parts);
}

function buildRequest(request: ChatRequest): Buffer {
	const parts: Buffer[] = [];

	parts.push(pbBytes(RequestField.metadata, buildClientMetadata(request.token)));
	if (request.systemPrompt) parts.push(pbString(RequestField.systemPrompt, request.systemPrompt));
	for (const prompt of request.prompts) parts.push(pbBytes(RequestField.prompts, encodePrompt(prompt)));

	parts.push(
		pbVarint(RequestField.flags, REQUEST_FLAG_VALUE),
		pbBytes(
			RequestField.sampling,
			Buffer.concat([
				pbVarint(Sampling.flag, SAMPLING_DEFAULTS.flag),
				pbVarint(Sampling.maxTokens, request.maxTokens),
				pbVarint(Sampling.reservedTokens, SAMPLING_DEFAULTS.reservedTokens),
				pbDouble(Sampling.temperature, request.temperature ?? SAMPLING_DEFAULTS.temperature),
				pbVarint(Sampling.topK, request.topK ?? SAMPLING_DEFAULTS.topK),
				pbDouble(Sampling.topP, Math.fround(request.topP ?? SAMPLING_DEFAULTS.topP)),
			]),
		),
	);

	for (const tool of request.tools) {
		if (!tool.name) continue;
		const encoded = Buffer.concat([
			pbString(ToolDefinitionField.name, tool.name),
			tool.description ? pbString(ToolDefinitionField.description, tool.description) : Buffer.alloc(0),
			tool.parametersJson
				? pbBytes(ToolDefinitionField.parameters, Buffer.from(tool.parametersJson, "utf8"))
				: Buffer.alloc(0),
		]);
		parts.push(pbBytes(RequestField.tools, encoded));
	}

	const lastPrompt = request.prompts.at(-1);
	const previousPrompt = request.prompts.at(-2);
	const startsUserTurn =
		lastPrompt?.source === PROMPT_SOURCE_USER &&
		(request.turnIndex === 0 || previousPrompt?.source !== PROMPT_SOURCE_USER);

	const thread: Buffer[] = [pbString(ThreadField.sessionId, request.threadId)];
	if (request.turnIndex > 0) thread.push(pbVarint(ThreadField.turnIndex, request.turnIndex));
	thread.push(pbVarint(ThreadField.marker, THREAD_MARKER_VALUE));
	if (startsUserTurn) thread.push(pbVarint(ThreadField.userTurnBoundary, USER_TURN_BOUNDARY_VALUE));

	parts.push(
		pbBytes(RequestField.thread, Buffer.concat(thread)),
		pbString(RequestField.cascadeId, request.cascadeId),
		pbVarint(RequestField.enabled, REQUEST_ENABLED_VALUE),
		pbString(RequestField.modelUid, request.modelUid),
		pbString(RequestField.sessionUuid, request.sessionUuid),
	);

	return Buffer.concat(parts);
}

const ResponseField = {
	text: 3,
	stopReason: 5,
	toolCall: 6,
	usage: 7,
	thinking: 9,
	signature: 10,
	signatureType: 21,
} as const;

const UsageField = { input: 2, output: 3, cacheWrite: 4, cacheRead: 5, responseModel: 9 } as const;
const ToolCallDeltaField = { id: 1, name: 2, arguments: 3 } as const;
const UpstreamStopReason = { incomplete: 1, maxTokens: 3, toolCalls: 10, contentFilter: 11 } as const;

interface ToolCallDelta {
	id: string;
	name: string;
	arguments: string;
}

interface FrameUsage {
	promptTokens: number;
	completionTokens: number;
	cachedTokens: number;
	cacheWriteTokens: number;
	responseModel?: string;
}

interface ParsedFrame {
	text: string;
	thinking: string;
	stopReason?: number;
	toolCalls: ToolCallDelta[];
	usage: FrameUsage;
	signature?: string;
	signatureType?: string;
}

function parseFrame(payload: Buffer): ParsedFrame {
	const texts: string[] = [];
	const thoughts: string[] = [];
	const toolCalls: ToolCallDelta[] = [];
	const usage: FrameUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
	let stopReason: number | undefined;
	let signature: string | undefined;
	let signatureType: string | undefined;

	for (const field of readFields(payload)) {
		if (field.wire === WIRE_VARINT) {
			if (field.field === ResponseField.stopReason) stopReason = Number(field.value as bigint);
			continue;
		}
		if (field.wire !== WIRE_BYTES) continue;

		const bytes = field.value as Buffer;
		if (field.field === ResponseField.text) {
			texts.push(bytes.toString("utf8"));
		} else if (field.field === ResponseField.thinking) {
			thoughts.push(bytes.toString("utf8"));
		} else if (field.field === ResponseField.signature) {
			signature = bytes.toString("utf8");
		} else if (field.field === ResponseField.signatureType) {
			signatureType = bytes.toString("utf8");
		} else if (field.field === ResponseField.toolCall) {
			const delta: ToolCallDelta = { id: "", name: "", arguments: "" };
			for (const entry of readFields(bytes)) {
				if (entry.wire !== WIRE_BYTES) continue;
				const value = (entry.value as Buffer).toString("utf8");
				if (entry.field === ToolCallDeltaField.id) delta.id = value;
				else if (entry.field === ToolCallDeltaField.name) delta.name = value;
				else if (entry.field === ToolCallDeltaField.arguments) delta.arguments = value;
			}
			toolCalls.push(delta);
		} else if (field.field === ResponseField.usage) {
			for (const entry of readFields(bytes)) {
				if (entry.wire === WIRE_VARINT) {
					const value = Number(entry.value as bigint);
					if (entry.field === UsageField.input) usage.promptTokens += value;
					else if (entry.field === UsageField.output) usage.completionTokens = value;
					else if (entry.field === UsageField.cacheWrite) usage.cacheWriteTokens += value;
					else if (entry.field === UsageField.cacheRead) usage.cachedTokens = value;
				} else if (entry.wire === WIRE_BYTES && entry.field === UsageField.responseModel) {
					const modelName = (entry.value as Buffer).toString("utf8");
					if (modelName) usage.responseModel = modelName;
				}
			}
		}
	}

	return { text: texts.join(""), thinking: thoughts.join(""), stopReason, toolCalls, usage, signature, signatureType };
}

type FinalStopReason = "length" | "stop" | "toolUse";

interface ActiveToolCall {
	call: ToolCall;
	contentIndex: number;
	arguments: string;
}

class ResponseAccumulator {
	private started = false;
	private textIndex = -1;
	private thinkingIndex = -1;
	private thinkingClosed = false;
	private lastCallKey: string | undefined;
	private stopReason: number | undefined;
	private signature: string | undefined;
	private readonly activeCalls = new Map<string, ActiveToolCall>();

	constructor(
		private readonly stream: AssistantMessageEventStream,
		private readonly output: AssistantMessage,
	) {}

	apply(frame: ParsedFrame): void {
		if (frame.stopReason !== undefined) this.stopReason = frame.stopReason;
		if (frame.usage.responseModel) this.output.responseModel = frame.usage.responseModel;
		if (frame.signature) {
			this.signature = frame.signature;
			rememberSignature(frame.signature, frame.signatureType);
		}
		if (frame.thinking) this.appendThinking(frame.thinking);
		if (frame.text) this.appendText(frame.text);
		for (const delta of frame.toolCalls) this.applyToolCallDelta(delta);
		if (
			frame.usage.promptTokens ||
			frame.usage.completionTokens ||
			frame.usage.cachedTokens ||
			frame.usage.cacheWriteTokens
		) {
			this.applyUsage(frame.usage);
		}
	}

	finish(): FinalStopReason {
		if (!this.started) throw new Error("Devin upstream returned no content");

		this.attachSignature();
		this.closeThinking();
		this.closeText();
		this.closeToolCalls();

		if (this.stopReason === UpstreamStopReason.contentFilter) {
			throw new Error("Devin blocked the response (content filter).");
		}

		const reason = this.resolveStopReason();
		this.output.stopReason = reason;
		return reason;
	}

	private ensureStarted(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private appendThinking(delta: string): void {
		this.ensureStarted();
		if (this.thinkingIndex === -1) {
			this.thinkingIndex = this.output.content.length;
			this.output.content.push({ type: "thinking", thinking: "" });
			this.stream.push({ type: "thinking_start", contentIndex: this.thinkingIndex, partial: this.output });
		}
		const block = this.output.content[this.thinkingIndex] as { thinking: string };
		block.thinking += delta;
		this.stream.push({ type: "thinking_delta", contentIndex: this.thinkingIndex, delta, partial: this.output });
	}

	private appendText(delta: string): void {
		this.ensureStarted();
		this.closeThinking();
		if (this.textIndex === -1) {
			this.textIndex = this.output.content.length;
			this.output.content.push({ type: "text", text: "" });
			this.stream.push({ type: "text_start", contentIndex: this.textIndex, partial: this.output });
		}
		const block = this.output.content[this.textIndex] as { text: string };
		block.text += delta;
		this.stream.push({ type: "text_delta", contentIndex: this.textIndex, delta, partial: this.output });
	}

	private applyToolCallDelta(delta: ToolCallDelta): void {
		this.ensureStarted();
		this.closeThinking();
		const key = delta.id || (delta.name ? `name:${delta.name}` : this.lastCallKey) || randomUUID();
		const active = this.activeCalls.get(key) ?? this.startToolCall(key, delta);
		if (delta.name && !active.call.name) active.call.name = delta.name;
		if (!delta.arguments) return;

		const cumulative = Boolean(active.arguments) && delta.arguments.startsWith(active.arguments);
		const chunk = cumulative ? delta.arguments.slice(active.arguments.length) : delta.arguments;
		active.arguments = cumulative ? delta.arguments : active.arguments + delta.arguments;
		this.stream.push({
			type: "toolcall_delta",
			contentIndex: active.contentIndex,
			delta: chunk,
			partial: this.output,
		});
	}

	private startToolCall(key: string, delta: ToolCallDelta): ActiveToolCall {
		const call: ToolCall = {
			type: "toolCall",
			id: delta.id || randomUUID(),
			name: delta.name || "",
			arguments: {},
		};
		const active: ActiveToolCall = { call, contentIndex: this.output.content.length, arguments: "" };
		this.output.content.push(call);
		this.activeCalls.set(key, active);
		this.lastCallKey = key;
		this.stream.push({ type: "toolcall_start", contentIndex: active.contentIndex, partial: this.output });
		return active;
	}

	private applyUsage(usage: FrameUsage): void {
		if (usage.promptTokens) this.output.usage.input = usage.promptTokens;
		if (usage.completionTokens) this.output.usage.output = usage.completionTokens;
		if (usage.cachedTokens) this.output.usage.cacheRead = usage.cachedTokens;
		if (usage.cacheWriteTokens) this.output.usage.cacheWrite = usage.cacheWriteTokens;
		this.output.usage.totalTokens =
			this.output.usage.input + this.output.usage.output + this.output.usage.cacheRead + this.output.usage.cacheWrite;
	}

	private attachSignature(): void {
		if (!this.signature) return;
		const block = this.signatureTarget();
		if (!block) return;
		if (block.type === "thinking") (block as { thinkingSignature?: string }).thinkingSignature = this.signature;
		else if (block.type === "text") (block as { textSignature?: string }).textSignature = this.signature;
		else (block as { thoughtSignature?: string }).thoughtSignature = this.signature;
	}

	private signatureTarget(): { type?: string } | undefined {
		if (this.thinkingIndex !== -1) return this.output.content[this.thinkingIndex] as { type?: string };
		if (this.textIndex !== -1) return this.output.content[this.textIndex] as { type?: string };
		return [...this.activeCalls.values()].at(-1)?.call;
	}

	private closeThinking(): void {
		if (this.thinkingIndex === -1 || this.thinkingClosed) return;
		this.thinkingClosed = true;
		this.attachSignature();
		const block = this.output.content[this.thinkingIndex] as { thinking: string };
		this.stream.push({
			type: "thinking_end",
			contentIndex: this.thinkingIndex,
			content: block.thinking,
			partial: this.output,
		});
	}

	private closeText(): void {
		if (this.textIndex === -1) return;
		const block = this.output.content[this.textIndex] as { text: string };
		this.stream.push({ type: "text_end", contentIndex: this.textIndex, content: block.text, partial: this.output });
	}

	private closeToolCalls(): void {
		for (const active of this.activeCalls.values()) {
			try {
				active.call.arguments = active.arguments ? (JSON.parse(active.arguments) as ToolCall["arguments"]) : {};
			} catch {
				active.call.arguments = {};
			}
			this.stream.push({
				type: "toolcall_end",
				contentIndex: active.contentIndex,
				toolCall: active.call,
				partial: this.output,
			});
		}
	}

	private resolveStopReason(): FinalStopReason {
		if (this.activeCalls.size > 0 || this.stopReason === UpstreamStopReason.toolCalls) return "toolUse";
		if (this.stopReason === UpstreamStopReason.incomplete || this.stopReason === UpstreamStopReason.maxTokens) return "length";
		return "stop";
	}
}

interface SessionState {
	threadId: string;
	cascadeId: string;
	sessionUuid: string;
	turnIndex: number;
}

let fallbackSessionId = randomUUID();
const sessionStates = new Map<string, SessionState>();

function nextSessionState(sessionKey: string): SessionState {
	let state = sessionStates.get(sessionKey);
	if (!state) {
		state = {
			threadId: sessionKey,
			cascadeId: randomUUID(),
			sessionUuid: randomUUID(),
			turnIndex: 0,
		};
		sessionStates.set(sessionKey, state);
	}
	const current = { ...state };
	state.turnIndex += 1;
	return current;
}

export function resetSessionState(): void {
	fallbackSessionId = randomUUID();
	sessionStates.clear();
	clearSignatures();
}

interface StreamContext {
	stream: AssistantMessageEventStream;
	output: AssistantMessage;
	model: Model<Api>;
	context: TranscriptContext;
	options?: SimpleStreamOptions;
	abortController: AbortController;
}

async function postChatRequest(context: StreamContext, body: Buffer, token: string): Promise<Response> {
	const chatUrl = `${(context.model.baseUrl || UPSTREAM_BASE).replace(/\/+$/, "")}${CHAT_PATH}`;
	const headers: Record<string, string> = {
		...context.model.headers,
		...context.options?.headers,
		Authorization: `Basic ${token}-${token}`,
		"Content-Type": "application/connect+proto",
		"Connect-Protocol-Version": "1",
		"connect-content-encoding": "gzip",
		Accept: "*/*",
		"Accept-Encoding": "gzip",
		"Sentry-Trace": sentryTrace(),
	};
	let framed = wrapConnectFrame(body);

	const instrumented = { url: chatUrl, headers, body: body.toString("base64"), encoding: "base64" as const };
	const replacement = (await context.options?.onPayload?.(instrumented, context.model)) as
		| { body?: unknown; encoding?: string }
		| undefined;
	if (replacement?.body !== undefined) {
		const raw = replacement.body;
		const replacementBody = Buffer.isBuffer(raw)
			? raw
			: raw instanceof Uint8Array
				? Buffer.from(raw)
				: typeof raw === "string"
					? Buffer.from(raw, replacement.encoding === "base64" ? "base64" : "utf8")
					: undefined;
		if (replacementBody) framed = wrapConnectFrame(replacementBody);
	}

	const doFetch = context.options?.fetch ?? fetch;
	const response = await doFetch(chatUrl, {
		method: "POST",
		headers,
		body: new Uint8Array(framed),
		signal: context.abortController.signal,
	});
	const responseHeaders: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		responseHeaders[key] = value;
	});
	await context.options?.onResponse?.({ status: response.status, headers: responseHeaders }, context.model);
	return response;
}

async function readFramePayloads(response: Response, onFrame: (payload: Buffer) => Promise<void>): Promise<void> {
	const reader = response.body?.getReader();
	if (!reader) return;

	const consumeFrames = async (pending: Buffer): Promise<Buffer> => {
		const frame = readConnectFrame(pending);
		if (!frame) return pending;

		const payload = (frame.flag & CONNECT_GZIP_FLAG) !== 0 ? gunzipSync(frame.payload) : frame.payload;
		if ((frame.flag & CONNECT_END_STREAM_FLAG) !== 0) {
			const trailer = parseConnectTrailer(payload);
			if (trailer?.error) {
				const code = trailer.error.code ? ` (${trailer.error.code})` : "";
				throw new Error(`Devin upstream error${code}: ${trailer.error.message ?? "unknown"}`);
			}
		} else {
			await onFrame(payload);
		}

		return consumeFrames(frame.rest);
	};

	const readChunks = async (pending: Buffer): Promise<void> => {
		const { done, value } = await reader.read();
		if (done) return;
		const leftover = await consumeFrames(Buffer.concat([pending, Buffer.from(value)]));
		return readChunks(leftover);
	};

	await readChunks(Buffer.alloc(0));
}

async function runStream(context: StreamContext): Promise<void> {
	const rawToken = context.options?.apiKey;
	if (!rawToken) throw new Error("Not logged in to Devin. Run /login devin.");
	const token = normalizeToken(rawToken);

	const sessionKey = context.options?.sessionId?.trim() || fallbackSessionId;
	const session = nextSessionState(sessionKey);

	const modelUid = resolveModelUid(context.model.id, context.options?.reasoning);
	context.output.responseModel = modelUid;

	const transcript = collapseSystemMessages(context.context);
	const tools = (getCurrentTools(transcript.messages) || []).map((tool) => ({
		name: tool.name,
		description: tool.description ?? "",
		parametersJson: JSON.stringify(tool.parameters ?? {}),
	}));

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

	const maxOutputCap = context.model.maxTokens || DEFAULT_MAX_TOKENS;
	const samplingParams = context.options?.samplingParams;
	const body = buildRequest({
		token,
		modelUid,
		systemPrompt: getCurrentSystemPrompt(transcript.messages) || "",
		prompts: toPrompts(transcript, { provider: context.model.provider, id: modelUid }),
		tools,
		threadId: session.threadId,
		cascadeId: session.cascadeId,
		sessionUuid: session.sessionUuid,
		turnIndex: session.turnIndex,
		maxTokens: Math.min(context.options?.maxTokens ?? maxOutputCap, maxOutputCap),
		temperature: finiteNumber(samplingParams?.temperature) ?? context.options?.temperature,
		topP: finiteNumber(samplingParams?.topP),
		topK: finiteNumber(samplingParams?.topK),
	});

	const response = await postChatRequest(context, body, token);
	if (!response.ok || !response.body) {
		const detail = await response.text().catch(() => "");
		const suffix = detail ? `: ${detail.slice(0, 300)}` : "";
		throw new Error(`Devin upstream HTTP ${response.status}${suffix}`);
	}

	const accumulator = new ResponseAccumulator(context.stream, context.output);
	await readFramePayloads(response, async (payload) => {
		const parsed = parseFrame(payload);
		await context.options?.onProviderStreamEvent?.(parsed, context.model);
		accumulator.apply(parsed);
	});
	const stopReason = accumulator.finish();

	context.stream.push({ type: "done", reason: stopReason, message: context.output });
	context.stream.end();
}

export function streamDevin(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const abortController = new AbortController();
	const forwardAbort = () => abortController.abort();
	options?.signal?.addEventListener("abort", forwardAbort, { once: true });

	const streamContext: StreamContext = {
		stream,
		output: {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
			...(options?.reasoning ? { thinkingLevel: options.reasoning } : {}),
		},
		model,
		context,
		options,
		abortController,
	};

	void (async () => {
		try {
			await runStream(streamContext);
		} catch (error) {
			const aborted = abortController.signal.aborted;
			streamContext.output.stopReason = aborted ? "aborted" : "error";
			streamContext.output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: streamContext.output });
			stream.end();
		} finally {
			options?.signal?.removeEventListener("abort", forwardAbort);
		}
	})();

	return stream;
}