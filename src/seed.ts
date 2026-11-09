/**
 * 副作用 import 用の入口。Worker のエントリの先頭で `import "better-auth-workers/seed";`。
 */
import { seedBetterAuthAsyncStorage } from "./als-seed.js";

seedBetterAuthAsyncStorage();

export { seedBetterAuthAsyncStorage };
