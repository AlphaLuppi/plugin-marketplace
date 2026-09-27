import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server";

createServer()
  .connect(new StdioServerTransport())
  .catch((err: unknown) => {
    console.error("x-context MCP server failed to start:", err);
    process.exit(1);
  });
