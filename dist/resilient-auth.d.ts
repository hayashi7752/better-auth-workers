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
export declare function createResilientAuth<A extends AuthLike>(factory: () => A, options?: ResilientAuthOptions): ResilientAuth<A>;
/**
 * isolate ごとに 1 回、`warm()` を `ctx.waitUntil` に載せて呼ぶ関数を作る。Worker の fetch ハンドラの先頭で呼ぶ。
 * 失敗したら次のリクエストでまたやる。
 */
export declare function createWarmup(warm: () => Promise<void>, warn?: (message: string) => void): (ctx: {
    waitUntil(promise: Promise<unknown>): void;
}) => void;
