import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Better Auth（@better-auth/core）が使う AsyncLocalStorage を、Worker の起動時（グローバルスコープ）に先回りで置く。
 *
 * core は `import("node:async_hooks")` の Promise をモジュールスコープに持ち（1.7.17 以前）、全 API 呼び出しが通る
 * `ensureAsyncStorage` がそれを await する。auth のモジュールをエントリから遅延 import していると、この Promise は
 * 「最初に auth に触ったリクエスト」の文脈（IoContext）で作られる。Workers ではそのリクエストが途中でキャンセル
 * されると Promise は永久に settle せず、以後その isolate の認証 API が全部固まる。
 * （better-auth/better-auth#10315。1.7.18 以降は core 側が `process.getBuiltinModule` に変えたので不要になるが、入れても害は無い）
 *
 * core の `ensureAsyncStorage` は globalThis[Symbol.for("better-auth:global")].context に既にインスタンスがあれば
 * import を待たずにそれを返すので、ここで静的 import の AsyncLocalStorage を 3 つ入れておけば import の Promise には
 * 誰も触らない。キー名は core の内部実装（1.6〜1.7: request-state / transaction / endpoint-context）。`??=` なので
 * 名前が変わっても壊れず、事前セットが効かなくなるだけ。test/als-seed.test.ts が core の getter で突き合わせている。
 *
 * **必ず Worker のエントリ（起動時に評価されるモジュール）から import すること。** 遅延 import の先に置くと意味がない。
 * 副作用 import の入口は `better-auth-workers/seed`。
 */
const BETTER_AUTH_GLOBAL = Symbol.for("better-auth:global");

type BetterAuthGlobal = {
	version: string;
	epoch: number;
	context: Record<string, unknown>;
};

export const SEEDED_STORAGE_KEYS = [
	"requestStateAsyncStorage",
	"adapterAsyncStorage",
	"endpointContextAsyncStorage",
] as const;

export function seedBetterAuthAsyncStorage(): BetterAuthGlobal {
	const holder = globalThis as unknown as Record<
		symbol,
		BetterAuthGlobal | undefined
	>;
	holder[BETTER_AUTH_GLOBAL] ??= { version: "seed", epoch: 0, context: {} };
	const shared = holder[BETTER_AUTH_GLOBAL];
	for (const key of SEEDED_STORAGE_KEYS)
		shared.context[key] ??= new AsyncLocalStorage();
	return shared;
}
