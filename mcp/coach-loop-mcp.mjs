#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCoachLoopMcpServer } from "./coach-loop-tools.mjs";

const server = createCoachLoopMcpServer({
  apiUrl: process.env.COACH_LOOP_API_URL,
  apiToken: process.env.COACH_LOOP_API_TOKEN
});

const transport = new StdioServerTransport();
await server.connect(transport);
