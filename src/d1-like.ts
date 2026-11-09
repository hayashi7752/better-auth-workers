/**
 * D1Database のうちこのパッケージが使う部分。`@cloudflare/workers-types` や `wrangler types` の D1Database を
 * そのまま渡せる（構造的に互換）。パッケージ側で Cloudflare の型に依存しないための最小の形。
 */
export interface D1ResultLike<T = unknown> {
	results?: T[];
	meta: { changes?: number | null; last_row_id?: number | null };
}

export interface D1StatementLike {
	bind(...values: unknown[]): D1StatementLike;
	all<T = unknown>(): Promise<D1ResultLike<T>>;
}

export interface D1Like {
	prepare(sql: string): D1StatementLike;
}
