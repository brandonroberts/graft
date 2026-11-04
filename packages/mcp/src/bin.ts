#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGraftServer } from './index.js';

// Usage: graft-mcp [--root <dir>]   (or set GRAFT_ROOT)
const i = process.argv.indexOf('--root');
const root = i !== -1 ? process.argv[i + 1] : undefined;

const server = createGraftServer({ root });
await server.connect(new StdioServerTransport());
