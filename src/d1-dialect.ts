import {
	type DatabaseConnection,
	type Dialect,
	type Driver,
	type Kysely,
	type QueryCompiler,
	type QueryResult,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from "kysely";
import type { D1Like } from "./d1-like.js";

/**
 * Better Auth に渡す D1 用の Kysely Dialect。**接続のミューテックスを持たない**ことだけが Better Auth 同梱の
 * D1SqliteDialect（`@better-auth/kysely-adapter`）との違い。
 *
 * Kysely 0.29 の RuntimeDriver は、アダプタの `supportsMultipleConnections` が false だと ConnectionMutex で
 * 接続の取得を直列化する（SQLite のファイル DB 向け）。同梱の D1SqliteAdapter は SqliteAdapter をそのまま継承して
 * false のままなので、isolate 内の全クエリが 1 つのロックを順番に待つ。ロックは provideConnection の finally で
 * 返すが、Workers では D1 の結果待ち中にリクエストがキャンセルされるとその Promise は永久に settle せず finally も
 * 走らないので、ロックが二度と返らず、以後その isolate の認証つきリクエストは全部「最初の D1 クエリの直前」で固まる。
 *
 * D1 は HTTP のステートレスな API で並行クエリに問題が無いので、ミューテックスは要らない。接続もリクエストごとに
 * 新しいオブジェクトを返し、共有状態を持たない。対話型トランザクションは D1 がサポートしないので投げる
 * （Better Auth には `transaction: false` で渡す）。
 *
 * @example
 * betterAuth({
 *   database: { dialect: new D1Dialect(env.DB), type: "sqlite", transaction: false },
 * })
 */
export class D1Dialect implements Dialect {
	constructor(private readonly db: D1Like) {}

	createAdapter() {
		return new D1Adapter();
	}
	createDriver(): Driver {
		return new D1Driver(this.db);
	}
	createQueryCompiler(): QueryCompiler {
		return new SqliteQueryCompiler();
	}
	createIntrospector(db: Kysely<unknown>) {
		return new SqliteIntrospector(db);
	}
}

/** SqliteAdapter と同じ SQL 方言。ただし並行接続を許し、Kysely にミューテックスを作らせない */
export class D1Adapter extends SqliteAdapter {
	override get supportsMultipleConnections(): boolean {
		return true;
	}
}

const NO_TRANSACTIONS =
	"D1 は対話型トランザクションをサポートしません（batch() を使う）";

class D1Driver implements Driver {
	constructor(private readonly db: D1Like) {}

	async init(): Promise<void> {}
	async acquireConnection(): Promise<DatabaseConnection> {
		return new D1Connection(this.db);
	}
	async beginTransaction(): Promise<void> {
		throw new Error(NO_TRANSACTIONS);
	}
	async commitTransaction(): Promise<void> {
		throw new Error(NO_TRANSACTIONS);
	}
	async rollbackTransaction(): Promise<void> {
		throw new Error(NO_TRANSACTIONS);
	}
	async releaseConnection(): Promise<void> {}
	async destroy(): Promise<void> {}
}

class D1Connection implements DatabaseConnection {
	constructor(private readonly db: D1Like) {}

	async executeQuery<R>(compiledQuery: {
		sql: string;
		parameters: readonly unknown[];
	}): Promise<QueryResult<R>> {
		const results = await this.db
			.prepare(compiledQuery.sql)
			.bind(...compiledQuery.parameters)
			.all<R>();
		const { changes, last_row_id } = results.meta;
		return {
			insertId:
				last_row_id === undefined || last_row_id === null
					? undefined
					: BigInt(last_row_id),
			rows: results.results ?? [],
			numAffectedRows: changes != null ? BigInt(changes) : undefined,
		};
	}

	async *streamQuery(): AsyncIterableIterator<never> {
		throw new Error("D1 はストリーミングクエリをサポートしません");
	}
}
