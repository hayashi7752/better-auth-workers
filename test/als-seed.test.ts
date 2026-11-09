import {
	getCurrentAuthContextAsyncLocalStorage,
	getCurrentDBAdapterAsyncLocalStorage,
	getRequestStateAsyncLocalStorage,
} from "@better-auth/core/context";
import { describe, expect, it } from "vitest";
import { SEEDED_STORAGE_KEYS, seedBetterAuthAsyncStorage } from "../src/als-seed.js";

/**
 * 事前セットした AsyncLocalStorage を core が本当に使うか（キー名が core の内部実装と合っているか）。
 * better-auth を上げてここが落ちたら、core の context/{request-state,transaction,endpoint-context} のキー名を見て
 * SEEDED_STORAGE_KEYS を合わせる。
 */
describe("seedBetterAuthAsyncStorage", () => {
	it("core の ensureAsyncStorage が事前セットしたインスタンスをそのまま返す", async () => {
		const shared = seedBetterAuthAsyncStorage();
		for (const key of SEEDED_STORAGE_KEYS) expect(shared.context[key]).toBeDefined();
		expect(await getRequestStateAsyncLocalStorage()).toBe(shared.context.requestStateAsyncStorage);
		expect(await getCurrentDBAdapterAsyncLocalStorage()).toBe(shared.context.adapterAsyncStorage);
		expect(await getCurrentAuthContextAsyncLocalStorage()).toBe(shared.context.endpointContextAsyncStorage);
	});

	it("2 回呼んでも置き換えない", () => {
		const a = seedBetterAuthAsyncStorage();
		const before = { ...a.context };
		const b = seedBetterAuthAsyncStorage();
		expect(b).toBe(a);
		for (const key of SEEDED_STORAGE_KEYS) expect(b.context[key]).toBe(before[key]);
	});
});
