import { describe, expect, it, vi } from "vitest";
import { type AuthLike, createResilientAuth, createWarmup } from "../src/resilient-auth.js";

type Fake = AuthLike & { id: number };

function fakeAuth(id: number, init: Promise<unknown>, handler?: () => Promise<Response>): Fake {
	return {
		id,
		$context: init,
		handler: handler ?? (async () => new Response(`ok ${id}`)),
		api: { getSession: async () => ({ id }) },
	};
}

describe("createResilientAuth", () => {
	it("init が永久に返らない instance は捨てて、待つ側の文脈で作り直す", async () => {
		const warn = vi.fn();
		let n = 0;
		const { auth } = createResilientAuth(
			() => {
				n++;
				// 1 つ目 = キャンセルされたリクエストが始めた init（settle しない）
				return fakeAuth(n, n === 1 ? new Promise(() => {}) : Promise.resolve());
			},
			{ initTimeoutMs: 50, warn },
		);
		const res = await auth.handler(new Request("https://x/api/auth/ok"));
		expect(await res.text()).toBe("ok 2");
		expect(n).toBe(2);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("作り直しも終わらなければ失敗にする（永久には待たない）", async () => {
		const { auth } = createResilientAuth(
			() => fakeAuth(1, new Promise(() => {})),
			{ initTimeoutMs: 30, warn: () => {} },
		);
		await expect(auth.handler(new Request("https://x/"))).rejects.toThrow("タイムアウト");
	});

	it("本体の呼び出しが返らなければ instance を捨て、次のリクエストは新しい instance を使う", async () => {
		const warn = vi.fn();
		let n = 0;
		const { auth } = createResilientAuth(
			() => {
				n++;
				const id = n;
				return fakeAuth(id, Promise.resolve(), id === 1 ? () => new Promise(() => {}) : undefined);
			},
			{ callStallMs: 50, warn },
		);
		await expect(auth.handler(new Request("https://x/"))).rejects.toThrow("タイムアウト");
		expect(warn).toHaveBeenCalledTimes(1);
		const res = await auth.handler(new Request("https://x/"));
		expect(await res.text()).toBe("ok 2");
	});

	it("api.* も初期化を待ってから呼ぶ", async () => {
		const { auth } = createResilientAuth(() => fakeAuth(7, Promise.resolve()));
		expect(await (auth.api as { getSession: () => Promise<{ id: number }> }).getSession()).toEqual({ id: 7 });
	});

	it("createWarmup は isolate ごとに 1 回だけ waitUntil に載せ、失敗したらまた試す", async () => {
		let calls = 0;
		const warm = vi.fn(async () => {
			calls++;
			if (calls === 1) throw new Error("boom");
		});
		const warmup = createWarmup(warm, () => {});
		const tasks: Promise<unknown>[] = [];
		const ctx = { waitUntil: (p: Promise<unknown>) => tasks.push(p) };
		warmup(ctx);
		warmup(ctx);
		await Promise.all(tasks);
		expect(warm).toHaveBeenCalledTimes(1);
		warmup(ctx); // 失敗したのでもう一度
		await Promise.all(tasks);
		expect(warm).toHaveBeenCalledTimes(2);
		warmup(ctx); // 成功したので以後は呼ばない
		expect(warm).toHaveBeenCalledTimes(2);
	});
});
