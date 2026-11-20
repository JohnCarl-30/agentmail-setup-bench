import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";

import { createApp } from "./app.ts";
import { Store } from "./store.ts";

const adminToken = process.env.REFEREE_ADMIN_TOKEN ?? "";
// Fail closed: without a real token anyone could create runs and read reports.
if (adminToken.length < 16) {
  console.error("Set REFEREE_ADMIN_TOKEN to a random string of at least 16 characters.");
  process.exit(1);
}

const dbPath = process.env.REFEREE_DB ?? "data/referee.db";
if (dbPath !== ":memory:") {
  mkdirSync(dirname(dbPath), { recursive: true });
}
const port = Number(process.env.PORT ?? 8787);

const store = new Store(dbPath);
const server = createServer(createApp({ store, adminToken }));

server.listen(port, () => {
  console.log(`Referee listening on http://localhost:${port} (database: ${dbPath})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
