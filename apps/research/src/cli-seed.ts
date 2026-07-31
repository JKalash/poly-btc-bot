import { makeDb } from "@b5p/db";
import { seedAll } from "./seed";

const db = await makeDb();
await db.migrate();
await seedAll(db);
console.log("[research] seed complete: timing-lab tables + 95c tutorial case + default config");
await db.close();
