import { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { D1Dialect } from "../src/d1-dialect.js";
import type { D1Like } from "../src/d1-like.js";

/** `.all()` の挙動を差し替えられる最小の D1 もどき */
function fakeD1(all: (sql: string) => Promise<unknown>): D1Like {
	return {
		prepare(sql: string) {
			const stmt = {
				bind: () => stmt,
				all: () => all(sql),
			};
			return stmt as never;
		},
	};
}

describe("D1Dialect", () => {
	it("並行接続を許す（Kysely にミューテックスを作らせない）", () => {
		expect(
			new D1Dialect(fakeD1(async () => ({}))).createAdapter()
				.supportsMultipleConnections,
		).toBe(true);
	});

	it("1 つ目のクエリが永久に返らなくても 2 つ目は完了する", async () => {
		let calls = 0;
		const db = new Kysely<{ t: { id: number } }>({
			dialect: new D1Dialect(
				fakeD1((sql) => {
					calls++;
					// 最初のクエリ = キャンセルされたリクエストの D1 待ち（settle しない）
					if (calls === 1) return new Promise(() => {});
					return Promise.resolve({
						results: [{ id: 2, sql }],
						meta: { changes: 0, last_row_id: null },
					});
				}),
			),
		});
		const hung = db.selectFrom("t").selectAll().execute();
		hung.catch(() => {});
		const second = await Promise.race([
			db.selectFrom("t").selectAll().execute(),
			new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 500)),
		]);
		expect(second).not.toBe("timeout");
		expect(second).toEqual([{ id: 2, sql: expect.stringContaining("from") }]);
	});

	it("結果の meta を Kysely の形に写す", async () => {
		const db = new Kysely<{ t: { id: number } }>({
			dialect: new D1Dialect(
				fakeD1(async () => ({
					results: [],
					meta: { changes: 3, last_row_id: 7 },
				})),
			),
		});
		const res = await db.deleteFrom("t").executeTakeFirst();
		expect(res.numDeletedRows).toBe(3n);
	});
});
