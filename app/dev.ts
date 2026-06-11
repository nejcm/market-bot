import { join } from "node:path";
import { resolveResearchConsoleConfig } from "../src/config";

const config = resolveResearchConsoleConfig();
const env = { ...process.env, MARKET_BOT_CONSOLE_PORT: String(config.port) };

const apiServer = Bun.spawn(["bun", "--hot", join(import.meta.dir, "server.ts")], {
  stdio: ["inherit", "inherit", "inherit"],
  env,
});

const viteServer = Bun.spawn(
  ["bunx", "vite", "--config", join(import.meta.dir, "vite.config.ts")],
  {
    stdio: ["inherit", "inherit", "inherit"],
    env,
  },
);

function shutdown(): void {
  apiServer.kill();
  viteServer.kill();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const exitCode = await Promise.race([apiServer.exited, viteServer.exited]);
shutdown();
process.exit(exitCode);
