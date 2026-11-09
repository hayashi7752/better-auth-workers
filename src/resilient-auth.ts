/**
 * Better Auth の instance を isolate 内で共有しつつ、「始めたリクエストのキャンセルで永久に settle しなくなった
 * Promise」に後続が巻き込まれないようにする薄いラッパー。
 *
 * Workers では setTimeout も D1 も dynamic import も、それを始めたリクエストの IoContext に結びつく。Better Auth は
 * init（`$context`）の Promise を instance 内で共有するので、init を始めたリクエストが途中でキャンセルされると、
 * 後続はその死んだ Promise を永久に待つ（better-auth/better-auth#10315。修正 PR #11482 は 2026-11 時点で未マージ）。
 *
 * ここでやること:
 * 1. instance は遅延生成（モジュールのトップレベルで D1 に触ると Workers で怒られるため）。
 * 2. init を待つタイマーは**待つ側のリクエストが自分の文脈で作る**（共有すると一緒に死ぬ）。時間切れなら instance を
 *    捨てて自分の文脈で作り直し、1 回だけやり直す。
 * 3. 本体の呼び出し（handler / api.*）がいつまでも返らなければ、共有 instance を捨てて次のリクエストに作り直させる
 *    （isolate 内で共有される何か = Kysely の接続ミューテックス等が二度と解放されなくなったときの保険。
 *    このリクエスト自体は失敗にし、再試行はしない: POST を二重実行しないため）。
 * 4. `warm()` を `ctx.waitUntil` に載せて最初のリクエストで呼べば、始めたリクエストのクライアントが切れても init が
 *    完了する（`createWarmup`）。
 */

export interface AuthLike {
	$context: Promise<unknown>;
	handler: (request: Request) => Promise<Response>;
	api: object;
}

export interface ResilientAuthOptions {
	/** init（$context）をこれ以上待たない。普段の init は 100〜200ms。既定 3000 */
	initTimeoutMs?: number;
	/** 本体の呼び出しがこれ以上返らなければ instance を捨てる。既定 20000 */
	callStallMs?: number;
	/** 作り直し・捨てたときの通知。既定は console.warn */
	warn?: (message: string) => void;
}

export interface ResilientAuth<A extends AuthLike> {
	/** Better Auth 本体として使う Proxy。handler と api.* は初期化の完了を待ってから呼ばれる */
	auth: A;
	/** 初期化を先に走らせる（ctx.waitUntil 用） */
	warm: () => Promise<void>;
	/** 共有 instance を捨てる（テスト・緊急用） */
	reset: () => void;
}

class TimeoutError extends Error {}

function waitFor<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		p,
		new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new TimeoutError(`${what} がタイムアウトしました`)),
				ms,
			);
		}),
	]).finally(() => clearTimeout(timer));
}

export function createResilientAuth<A extends AuthLike>(
	factory: () => A,
	options: ResilientAuthOptions = {},
): ResilientAuth<A> {
	const initTimeoutMs = options.initTimeoutMs ?? 3000;
	const callStallMs = options.callStallMs ?? 20_000;
	const warn = options.warn ?? ((m) => console.warn(`[better-auth-workers] ${m}`));

	let instance: A | undefined;

	function create(): A {
		const inst = factory();
		instance = inst;
		inst.$context.catch(() => {
			if (instance === inst) instance = undefined;
		});
		return inst;
	}
	function current(): A {
		return instance ?? create();
	}

	async function ensureReady(): Promise<A> {
		const inst = current();
		try {
			await waitFor(inst.$context, initTimeoutMs, "Better Auth の初期化");
			return inst;
		} catch (e) {
			if (instance === inst) instance = undefined;
			warn(
				`初期化を待ち切れなかったので作り直します: ${e instanceof Error ? e.message : String(e)}`,
			);
			const next = current();
			await waitFor(next.$context, initTimeoutMs, "Better Auth の初期化");
			return next;
		}
	}

	async function withStallGuard<T>(inst: A, call: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				call,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						if (instance === inst) instance = undefined;
						warn(`呼び出しが ${callStallMs / 1000} 秒返らないので instance を捨てます`);
						reject(new TimeoutError("Better Auth の呼び出しがタイムアウトしました"));
					}, callStallMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
			call.catch(() => {});
		}
	}

	function deferred<Args extends unknown[], R>(
		pick: (auth: A) => (...args: Args) => R,
	): (...args: Args) => Promise<R> {
		return async (...args) => {
			const inst = await ensureReady();
			return (await withStallGuard(inst, Promise.resolve(pick(inst)(...args)))) as R;
		};
	}

	const auth = new Proxy({} as A, {
		get(_, key) {
			const inst = current();
			if (key === "handler")
				return deferred((a) => a.handler) as unknown as A["handler"];
			if (key === "api")
				return new Proxy({} as A["api"], {
					get(_api, apiKey) {
						const target = Reflect.get(inst.api, apiKey) as unknown;
						if (typeof target !== "function") return target;
						return deferred(
							(a) =>
								Reflect.get(a.api, apiKey) as (...args: unknown[]) => unknown,
						);
					},
					has(_api, apiKey) {
						return Reflect.has(inst.api, apiKey);
					},
				});
			return Reflect.get(inst, key);
		},
		has(_, key) {
			return Reflect.has(current(), key);
		},
	});

	return {
		auth,
		warm: async () => {
			await ensureReady();
		},
		reset: () => {
			instance = undefined;
		},
	};
}

/**
 * isolate ごとに 1 回、`warm()` を `ctx.waitUntil` に載せて呼ぶ関数を作る。Worker の fetch ハンドラの先頭で呼ぶ。
 * 失敗したら次のリクエストでまたやる。
 */
export function createWarmup(
	warm: () => Promise<void>,
	warn: (message: string) => void = (m) =>
		console.warn(`[better-auth-workers] ${m}`),
): (ctx: { waitUntil(promise: Promise<unknown>): void }) => void {
	let warmed = false;
	return (ctx) => {
		if (warmed) return;
		warmed = true;
		ctx.waitUntil(
			warm().catch((e) => {
				warmed = false;
				warn(`事前初期化に失敗: ${e instanceof Error ? e.message : String(e)}`);
			}),
		);
	};
}
