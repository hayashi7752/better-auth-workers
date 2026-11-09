import { SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, } from "kysely";
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
export class D1Dialect {
    db;
    constructor(db) {
        this.db = db;
    }
    createAdapter() {
        return new D1Adapter();
    }
    createDriver() {
        return new D1Driver(this.db);
    }
    createQueryCompiler() {
        return new SqliteQueryCompiler();
    }
    createIntrospector(db) {
        return new SqliteIntrospector(db);
    }
}
/** SqliteAdapter と同じ SQL 方言。ただし並行接続を許し、Kysely にミューテックスを作らせない */
export class D1Adapter extends SqliteAdapter {
    get supportsMultipleConnections() {
        return true;
    }
}
const NO_TRANSACTIONS = "D1 は対話型トランザクションをサポートしません（batch() を使う）";
class D1Driver {
    db;
    constructor(db) {
        this.db = db;
    }
    async init() { }
    async acquireConnection() {
        return new D1Connection(this.db);
    }
    async beginTransaction() {
        throw new Error(NO_TRANSACTIONS);
    }
    async commitTransaction() {
        throw new Error(NO_TRANSACTIONS);
    }
    async rollbackTransaction() {
        throw new Error(NO_TRANSACTIONS);
    }
    async releaseConnection() { }
    async destroy() { }
}
class D1Connection {
    db;
    constructor(db) {
        this.db = db;
    }
    async executeQuery(compiledQuery) {
        const results = await this.db
            .prepare(compiledQuery.sql)
            .bind(...compiledQuery.parameters)
            .all();
        const { changes, last_row_id } = results.meta;
        return {
            insertId: last_row_id === undefined || last_row_id === null
                ? undefined
                : BigInt(last_row_id),
            rows: results.results ?? [],
            numAffectedRows: changes != null ? BigInt(changes) : undefined,
        };
    }
    async *streamQuery() {
        throw new Error("D1 はストリーミングクエリをサポートしません");
    }
}
