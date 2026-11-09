import type { D1Like } from "./d1-like.js";
/**
 * 調査用: D1 の prepare().all() 等の開始・終了を記録する Proxy。固まる場所の特定に使う。
 * `wrangler tail --format json` では、キャンセルされたリクエスト（outcome: canceled）のログも残るので、
 * 「最後に出たマーク」で止まった場所が分かる（README の「固まる場所の特定」を参照）。
 */
export declare function traceD1<T extends D1Like>(db: T, log: (stage: string, detail?: string) => void): T;
