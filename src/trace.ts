import type { D1Like, D1StatementLike } from "./d1-like.js";

/**
 * 調査用: D1 の prepare().all() 等の開始・終了を記録する Proxy。固まる場所の特定に使う。
 * `wrangler tail --format json` では、キャンセルされたリクエスト（outcome: canceled）のログも残るので、
 * 「最後に出たマーク」で止まった場所が分かる（README の「固まる場所の特定」を参照）。
 */
export function traceD1<T extends D1Like>(
	db: T,
	log: (stage: string, detail?: string) => void,
): T {
	let seq = 0;
	const wrapStmt = (stmt: D1StatementLike, sql: string): D1StatementLike =>
		new Proxy(stmt, {
			get(t, k) {
				const v = Reflect.get(t, k, t) as unknown;
				if (typeof v !== "function") return v;
				if (k === "bind")
					return (...args: unknown[]) =>
						wrapStmt(
							(v as (...a: unknown[]) => D1StatementLike).apply(t, args),
							sql,
						);
				if (k === "all" || k === "first" || k === "run" || k === "raw")
					return async (...args: unknown[]) => {
						const id = ++seq;
						const t0 = Date.now();
						log(`d1:${String(k)}:start#${id}`, sql.slice(0, 60));
						try {
							return await (v as (...a: unknown[]) => Promise<unknown>).apply(
								t,
								args,
							);
						} finally {
							log(`d1:${String(k)}:done#${id}`, `${Date.now() - t0}ms`);
						}
					};
				return (v as (...a: unknown[]) => unknown).bind(t);
			},
		});
	return new Proxy(db, {
		get(t, k) {
			const v = Reflect.get(t, k, t) as unknown;
			if (typeof v !== "function") return v;
			if (k === "prepare")
				return (sql: string) =>
					wrapStmt((v as (s: string) => D1StatementLike).call(t, sql), sql);
			if (k === "batch")
				return async (...args: unknown[]) => {
					const id = ++seq;
					const t0 = Date.now();
					log(`d1:batch:start#${id}`);
					try {
						return await (v as (...a: unknown[]) => Promise<unknown>).apply(
							t,
							args,
						);
					} finally {
						log(`d1:batch:done#${id}`, `${Date.now() - t0}ms`);
					}
				};
			return (v as (...a: unknown[]) => unknown).bind(t);
		},
	});
}
