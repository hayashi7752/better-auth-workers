# better-auth-workers

Better Auth を Cloudflare Workers（+ D1）で動かすと、**認証を通る経路だけが isolate 単位で永久に固まる**ことがある。その原因 3 つを塞ぐための小さなセット。

> **TL;DR (English).** On Cloudflare Workers, a promise/lock created while handling a request dies with that request when the client cancels it (prerender, abort, `curl -m 0.05`). Better Auth + D1 shares three such things per isolate: (1) the init promise `$context`, (2) the module-scope `import("node:async_hooks")` in `@better-auth/core` (fixed upstream in 1.7.18), and (3) **Kysely's `ConnectionMutex`**, which the bundled D1 adapter enables by leaving `supportsMultipleConnections = false`. One cancelled request mid-query leaks the lock forever and every later auth request in that isolate hangs before its first D1 query. This package ships a mutex-free `D1Dialect`, an AsyncLocalStorage pre-seed, and a resilient instance wrapper with per-waiter timeouts. See better-auth/better-auth#10315 for (1) and (2); (3) was not reported there as of 2026-11.

## 症状

- `/api/auth/*` や `getSession` を通る経路だけが、一定の割合（isolate 単位）で応答しない。auth を触らない経路は正常。
- `wrangler tail --format json` で、固まったリクエストは `outcome: canceled`（クライアントが諦めた）、`cpuTime` が数 ms、`wallTime` がクライアントのタイムアウト。ログも例外も無い。
- 特定のブラウザ・特定の人だけ固まって見える（接続は同じ isolate に張り付くため）。ブラウザを再起動すると直る。
- 一度汚染された isolate は捨てられるまで直らない。同じ版の再デプロイでは isolate が入れ替わらない。

## 原因

Workers では、リクエスト処理中に作られた Promise・タイマー・D1 呼び出し・dynamic import は、そのリクエストの IoContext に属する。クライアントが先に切ると、それらは reject も resolve もされず永久に pending のまま残る。isolate 内で共有されているものがこの状態になると、後続のリクエストが全部それを待って固まる。Better Auth + D1 ではそれが 3 つある。

| # | 共有されているもの | 状況 | このパッケージの対処 |
|---|---|---|---|
| 1 | `$context`（init の Promise。instance 内で共有） | [#10315](https://github.com/better-auth/better-auth/issues/10315)。修正 PR #11482 は 2026-11 時点で未マージ | `createResilientAuth`: 待つ側のリクエストが自分の文脈でタイマーを作り、時間切れなら instance を捨てて作り直す。`createWarmup` で init を `ctx.waitUntil` に係留 |
| 2 | `@better-auth/core/async_hooks` の `import("node:async_hooks")`（モジュールスコープ） | 同 #10315。**1.7.18 で修正済み**（`process.getBuiltinModule` に変更） | `better-auth-workers/seed`: 起動時に AsyncLocalStorage を 3 つ先回りで置く（1.7.17 以前向け。入れても害は無い） |
| 3 | **Kysely の `ConnectionMutex`**（isolate 内の全クエリが 1 つのロックを順番待ち） | 同梱の `D1SqliteAdapter` が `SqliteAdapter` の `supportsMultipleConnections = false` を継承。D1 待ち中にキャンセルされるとロックが二度と返らない。未報告 | `D1Dialect`: 並行接続を許し、接続はリクエストごとに新規 |

3 は、1 と 2 を塞いでも残る。段階マークを入れて「init 済み・handler に入って**最初の D1 クエリの直前**で止まる」のを見て特定した。

## 導入

```sh
npm i github:hayashi7752/better-auth-workers kysely
```

`kysely` は peer 依存。Better Auth が内部で使っている版（`npm ls kysely`）と合わせる。

### 1. Worker のエントリ（起動時に評価されるモジュール）で seed

```ts
// src/worker.ts の先頭。遅延 import の先に置くと意味がない
import "better-auth-workers/seed";
```

### 2. Better Auth に D1Dialect を渡し、instance を createResilientAuth で包む

```ts
// src/server/auth.ts
import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { D1Dialect, createResilientAuth } from "better-auth-workers";

function createAuth() {
  return betterAuth({
    // 同梱の D1 検出（database: env.DB）を通さず、自前の Dialect を渡す
    database: { dialect: new D1Dialect(env.DB), type: "sqlite", transaction: false },
    // スキーマ検査も同じ構造の共有 Promise なので切る（スキーマは migrations で担保する）
    advanced: { database: { validateSchema: false } },
    // ...
  });
}

export const { auth, warm } = createResilientAuth(createAuth);
// auth.handler / auth.api.* をいつも通り使う。初期化の完了を待ってから呼ばれる
```

### 3. fetch ハンドラで init を waitUntil に係留

```ts
// src/worker.ts
import { createWarmup } from "better-auth-workers";
import { warm } from "./server/auth";

const warmup = createWarmup(warm);

export default {
  fetch(request, env, ctx) {
    warmup(ctx); // isolate ごとに 1 回だけ
    // ...
  },
};
```

`createResilientAuth` のオプション: `initTimeoutMs`（既定 3000。普段の init は 100〜200ms）、`callStallMs`（既定 20000。本体の呼び出しがこれ以上返らなければ instance を捨てる。そのリクエスト自体は失敗。再試行はしない）、`warn`（通知。既定 `console.warn`）。

## 確認のしかた

```sh
# 1. 別ターミナルで tail を溜める
npx wrangler tail --format json > tail.jsonl
# 2. キャンセル 200 件で汚染 → 各経路 40 回。auth を触らない経路（/login 等）を対照に
scripts/probe.sh https://your.app /api/auth/ok /api/auth/get-session /login
```

直っていれば全経路 `timeout=0`。壊れていると isolate 単位で固まるので、1 割〜9 割がタイムアウトになる。tail 側は `outcome: canceled` のうち wallTime がクライアントのタイムアウト一杯のものが固まったリクエスト。

## 固まる場所の特定（別の原因を疑うとき）

`traceD1(env.DB, log)` で D1 を包み、自分のコードの各段階にも `console.info` のマークを入れて本番に出す。`wrangler tail --format json` では、キャンセルされたリクエストのログも残る（負荷が高いとイベントごと落ちることはある）。`outcome: canceled` のイベントの `logs` の最後のマークを集計すれば、止まった場所が分かる。今回は `init 済み → handler 呼び出し → （ここで停止）→ 最初の D1` で、handler 入口から最初の D1 までのコードを読んで Kysely のミューテックスに辿り着いた。

## 互換性

- better-auth / @better-auth/core 1.6〜1.7.18、kysely 0.27〜0.29 で確認。
- seed のキー名（`requestStateAsyncStorage` / `adapterAsyncStorage` / `endpointContextAsyncStorage`）は core の内部実装。`test/als-seed.test.ts` が core の getter と突き合わせているので、better-auth を上げたらこのパッケージのテストを回す。
- `D1Dialect` を渡すと Better Auth 同梱の D1 用インデックス introspection は使われない。実行時のスキーマ検査を切っていれば関係ない。CLI でスキーマ差分を出すときは別の config（better-sqlite3 等）を使う。

## 関連

- 記事: [Cloudflare Workers で better-auth が固まる](https://zenn.dev/coji/articles/cloudflare-workers-better-auth-hanging-promise)（1 と 2 の発見と 3 層の回避策）
- better-auth/better-auth [#10315](https://github.com/better-auth/better-auth/issues/10315)（1・2）、[#11651](https://github.com/better-auth/better-auth/issues/11651)（スキーマ検査）、PR #11482（init の bound と `better-auth/cloudflare`）
- kysely: `RuntimeDriver` の `ConnectionMutex`（`supportsMultipleConnections === false` のとき）
