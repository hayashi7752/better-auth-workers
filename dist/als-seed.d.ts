type BetterAuthGlobal = {
    version: string;
    epoch: number;
    context: Record<string, unknown>;
};
export declare const SEEDED_STORAGE_KEYS: readonly ["requestStateAsyncStorage", "adapterAsyncStorage", "endpointContextAsyncStorage"];
export declare function seedBetterAuthAsyncStorage(): BetterAuthGlobal;
export {};
