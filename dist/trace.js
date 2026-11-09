/**
 * 調査用: D1 の prepare().all() 等の開始・終了を記録する Proxy。固まる場所の特定に使う。
 * `wrangler tail --format json` では、キャンセルされたリクエスト（outcome: canceled）のログも残るので、
 * 「最後に出たマーク」で止まった場所が分かる（README の「固まる場所の特定」を参照）。
 */
export function traceD1(db, log) {
    let seq = 0;
    const wrapStmt = (stmt, sql) => new Proxy(stmt, {
        get(t, k) {
            const v = Reflect.get(t, k, t);
            if (typeof v !== "function")
                return v;
            if (k === "bind")
                return (...args) => wrapStmt(v.apply(t, args), sql);
            if (k === "all" || k === "first" || k === "run" || k === "raw")
                return async (...args) => {
                    const id = ++seq;
                    const t0 = Date.now();
                    log(`d1:${String(k)}:start#${id}`, sql.slice(0, 60));
                    try {
                        return await v.apply(t, args);
                    }
                    finally {
                        log(`d1:${String(k)}:done#${id}`, `${Date.now() - t0}ms`);
                    }
                };
            return v.bind(t);
        },
    });
    return new Proxy(db, {
        get(t, k) {
            const v = Reflect.get(t, k, t);
            if (typeof v !== "function")
                return v;
            if (k === "prepare")
                return (sql) => wrapStmt(v.call(t, sql), sql);
            if (k === "batch")
                return async (...args) => {
                    const id = ++seq;
                    const t0 = Date.now();
                    log(`d1:batch:start#${id}`);
                    try {
                        return await v.apply(t, args);
                    }
                    finally {
                        log(`d1:batch:done#${id}`, `${Date.now() - t0}ms`);
                    }
                };
            return v.bind(t);
        },
    });
}
