#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { createDeps, createMcpServer } from "./server.js";

async function main(): Promise<void> {
  const server = createMcpServer(createDeps(loadConfig(), { log }));
  await server.connect(new StdioServerTransport());
  log("mochi-mcp running on stdio");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
