import { createHash, randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const PROVIDER_ID = "devin";
export const API_ID = "devin-subscription";

export const UPSTREAM_BASE = "https://server.codeium.com";
export const CHAT_URL = `${UPSTREAM_BASE}/exa.api_server_pb.ApiServerService/GetChatMessage`;
export const CATALOG_URL = `${UPSTREAM_BASE}/exa.api_server_pb.ApiServerService/GetCliModelConfigs`;

export const APP_BASE = "https://app.devin.ai";
export const API_BASE = "https://api.devin.ai";

export const DEFAULT_MAX_TOKENS = 128_000;
export const MAX_OUTPUT_TOKENS = 64_000;

export const EXTENSION_DIR = join(
	process.env.USERPROFILE ?? process.env.HOME ?? tmpdir(),
	".pi",
	"agent",
	"extensions",
	"devin-sub",
);

export const CATALOG_CACHE_FILE = join(EXTENSION_DIR, "models-cache.json");
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

export const CONNECT_GZIP_FLAG = 0x01;
export const CONNECT_END_STREAM_FLAG = 0x02;
const CONNECT_HEADER_LENGTH = 5;

export interface ProtoField {
	field: number;
	wire: number;
	value: bigint | number | Buffer;
	raw: Buffer;
}

export interface ConnectFrame {
	flag: number;
	payload: Buffer;
	rest: Buffer;
}

export interface ConnectTrailer {
	error?: { code?: string; message?: string };
}

interface VarintRead {
	value: bigint;
	next: number;
}

function encodeVarint(value: number | bigint): Buffer {
	let remaining = typeof value === "bigint" ? value : BigInt(Math.max(0, Math.trunc(value)));
	const bytes: number[] = [];
	do {
		let byte = Number(remaining & 0x7fn);
		remaining >>= 7n;
		if (remaining > 0n) byte |= 0x80;
		bytes.push(byte);
	} while (remaining > 0n);
	return Buffer.from(bytes);
}

function readVarint(buffer: Buffer, start: number): VarintRead {
	let value = 0n;
	let shift = 0n;
	let position = start;
	while (position < buffer.length) {
		const byte = buffer[position++];
		value |= BigInt(byte & 0x7f) << shift;
		shift += 7n;
		if ((byte & 0x80) === 0) break;
	}
	return { value, next: position };
}

function tag(field: number, wire: number): Buffer {
	return encodeVarint((field << 3) | wire);
}

export function pbVarint(field: number, value: number | bigint): Buffer {
	return Buffer.concat([tag(field, WIRE_VARINT), encodeVarint(value)]);
}

export function pbString(field: number, value: string): Buffer {
	const bytes = Buffer.from(value, "utf8");
	return Buffer.concat([tag(field, WIRE_BYTES), encodeVarint(bytes.length), bytes]);
}

export function pbBytes(field: number, value: Buffer): Buffer {
	return Buffer.concat([tag(field, WIRE_BYTES), encodeVarint(value.length), value]);
}

export function pbDouble(field: number, value: number): Buffer {
	const payload = Buffer.alloc(8);
	payload.writeDoubleLE(value, 0);
	return Buffer.concat([tag(field, WIRE_FIXED64), payload]);
}

export function* readFields(buffer: Buffer): Generator<ProtoField> {
	let position = 0;
	while (position < buffer.length) {
		const start = position;
		const key = readVarint(buffer, position);
		if (key.next === position) return;
		position = key.next;

		const field = Number(key.value >> 3n);
		const wire = Number(key.value & 7n);

		if (wire === WIRE_VARINT) {
			const read = readVarint(buffer, position);
			position = read.next;
			yield { field, wire, value: read.value, raw: buffer.subarray(start, position) };
			continue;
		}

		if (wire === WIRE_FIXED64) {
			position += 8;
			yield { field, wire, value: buffer.readDoubleLE(position - 8), raw: buffer.subarray(start, position) };
			continue;
		}

		if (wire === WIRE_BYTES) {
			const length = readVarint(buffer, position);
			position = length.next;
			const value = buffer.subarray(position, position + Number(length.value));
			position += Number(length.value);
			yield { field, wire, value, raw: buffer.subarray(start, position) };
			continue;
		}

		if (wire === WIRE_FIXED32) {
			position += 4;
			continue;
		}

		return;
	}
}

export function readConnectFrame(buffer: Buffer): ConnectFrame | undefined {
	if (buffer.length < CONNECT_HEADER_LENGTH) return undefined;
	const flag = buffer[0];
	const length = buffer.readUInt32BE(1);
	const frameEnd = CONNECT_HEADER_LENGTH + length;
	if (buffer.length < frameEnd) return undefined;
	return {
		flag,
		payload: buffer.subarray(CONNECT_HEADER_LENGTH, frameEnd),
		rest: buffer.subarray(frameEnd),
	};
}

export function wrapConnectFrame(body: Buffer): Buffer {
	const payload = gzipSync(body);
	const header = Buffer.alloc(CONNECT_HEADER_LENGTH);
	header[0] = CONNECT_GZIP_FLAG;
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, payload]);
}

export function parseConnectTrailer(payload: Buffer): ConnectTrailer | undefined {
	try {
		return JSON.parse(payload.toString("utf8")) as ConnectTrailer;
	} catch {
		return undefined;
	}
}

export const TOKEN_PREFIX = "devin-session-token$";

const CLIENT_NAME = "devin-cli";
const CLIENT_PRODUCT = "chisel";
const CLIENT_VERSION = "3000.14.30821";
const CLIENT_LOCALE = "en";
const FINGERPRINT_HEX_LENGTH = 732;

const MetadataField = {
	name: 1,
	version: 2,
	token: 3,
	locale: 4,
	os: 5,
	buildVersion: 7,
	product: 12,
	productAlias: 28,
	fingerprint: 31,
} as const;

function fingerprint(): string {
	return randomBytes(FINGERPRINT_HEX_LENGTH / 2).toString("hex");
}

export function normalizeToken(token: string): string {
	const trimmed = token.trim();
	return trimmed.startsWith(TOKEN_PREFIX) ? trimmed : `${TOKEN_PREFIX}${trimmed}`;
}

export function sentryTrace(): string {
	const trace = createHash("sha256").update(randomUUID()).digest("hex");
	return `${trace.slice(0, 32)}-${trace.slice(32, 48)}-0`;
}

export function buildClientMetadata(token: string): Buffer {
	return Buffer.concat([
		pbString(MetadataField.name, CLIENT_NAME),
		pbString(MetadataField.version, CLIENT_VERSION),
		pbString(MetadataField.token, token),
		pbString(MetadataField.locale, CLIENT_LOCALE),
		pbString(MetadataField.os, process.platform === "win32" ? "windows" : process.platform),
		pbString(MetadataField.buildVersion, CLIENT_VERSION),
		pbString(MetadataField.product, CLIENT_PRODUCT),
		pbString(MetadataField.productAlias, CLIENT_PRODUCT),
		pbString(MetadataField.fingerprint, fingerprint()),
	]);
}