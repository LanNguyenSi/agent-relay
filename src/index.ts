import { env } from "./config/env.js";
import { createRelayServer } from "./server.js";

const server = createRelayServer();

server.listen(env.PORT, () => {
  console.log(`agent-relay listening on port ${env.PORT}`);
  console.log(`  API:  http://localhost:${env.PORT}/api`);
  console.log(`  MCP:  http://localhost:${env.PORT}/mcp`);
  console.log(`  Tools: relay_deploy, relay_status, relay_rollback, relay_logs, relay_preflight`);
});
