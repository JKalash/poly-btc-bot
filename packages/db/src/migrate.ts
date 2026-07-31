import { makeDb } from "./client";

const handle = await makeDb();
console.log(`[db] migrating (${handle.kind})...`);
await handle.migrate();
console.log("[db] migrations applied");
await handle.close();
