//http-server.ts

/*
 * Copyright 2025, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Toolset } from '@salesforce/mcp-provider-api';
import { SfMcpServer } from './sf-mcp-server.js';
import { Services } from './services.js';
import { registerToolsets } from './utils/registry-utils.js';
import { salesforceOAuthMiddleware } from './middleware/oauth-middleware.js';
import Cache from './utils/cache.js';
import cors from 'cors';
import helmet from 'helmet';

// Session storage for multi-user support
const transports = new Map<string, StreamableHTTPServerTransport>();
const mcpServers = new Map<string, SfMcpServer>();

/**
 * Create a new MCP server instance for a session
 */
async function createMcpServer(
  config: { name: string; version: string; capabilities: any },
  options: { telemetry?: any },
  toolsets: Array<Toolset | 'all'>,
  tools: string[],
  dynamicTools: boolean,
  allowNonGaTools: boolean,
  services: Services
): Promise<SfMcpServer> {
  const server = new SfMcpServer(config, options);

  // Register toolsets for this server instance
  await registerToolsets(toolsets, tools, dynamicTools, allowNonGaTools, server, services);

  return server;
}

/**
 * Start HTTP server with StreamableHTTP transport
 */
export async function startHttpServer(options: {
  host: string;
  port: number;
  config: any;
  telemetry?: any;
  toolsets: Array<Toolset | 'all'>;
  tools: string[];
  dynamicTools: boolean;
  allowNonGaTools: boolean;
  allowedOrgs: Set<string>;
  services: Services;
}): Promise<void> {
  const app = express();

  // Middleware
  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  // Request logging middleware
  app.use((req, _res, next) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ${req.method} ${req.path} - Session: ${req.headers['mcp-session-id'] || 'none'}`);

    // Log auth headers at entry point
    const authHeader = req.headers['authorization'];
    const instanceHeader = req.headers['x-salesforce-instance-url'];
    if (authHeader) {
      const isBearerToken = typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ');
      const tokenLength = isBearerToken ? authHeader.substring(7).length : 'N/A';
      console.error(`[${timestamp}] 🔐 Auth headers - Authorization: ${isBearerToken ? 'Bearer token (length: ' + tokenLength + ')' : 'present but not Bearer'}, Instance URL: ${instanceHeader || 'not provided'}`);
    } else {
      console.error(`[${timestamp}] ⚠️  No Authorization header in request`);
    }

    next();
  });

  app.use('/mcp', salesforceOAuthMiddleware);

  // Health check endpoint
  app.get('/health', (_req, res) => {
    const healthData = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      transport: 'streamable-http',
      sessions: transports.size
    };
    console.error(`[HTTP] Health check - ${transports.size} active sessions`);
    res.json(healthData);
  });

  // Main MCP endpoint - handles GET (SSE), POST (requests), DELETE (cleanup)
  app.all('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      let transport = sessionId ? transports.get(sessionId) : undefined;

      // NEW SESSION: Initialize request without session ID
      if (!sessionId && req.method === 'POST') {
        const body = req.body;

        // Only create session on initialize request
        if (body.method === 'initialize') {
          console.error(`[HTTP] Incoming initialize request - creating new session`);
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: async (newSessionId) => {
              console.error(`[HTTP] ✅ Session initialized: ${newSessionId}`);

              // Clear tool cache for new session (allows each session to register tools)
              await Cache.safeSet('tools', []);
              await Cache.safeSet('allowedOrgs', options.allowedOrgs);

              // Create MCP server for this session
              const server = await createMcpServer(
                options.config,
                { telemetry: options.telemetry },
                options.toolsets,
                options.tools,
                options.dynamicTools,
                options.allowNonGaTools,
                options.services
              );

              mcpServers.set(newSessionId, server);
              transports.set(newSessionId, transport!);

              // Connect server to transport
              await server.connect(transport!);
              console.error(`[HTTP] Session ${newSessionId} ready - tools registered`);
            },
            onsessionclosed: async (closedSessionId) => {
              console.error(`[HTTP] ❌ Session closed: ${closedSessionId}`);
              transports.delete(closedSessionId);
              mcpServers.delete(closedSessionId);
            }
          });
        } else {
          console.error(`[HTTP] ❌ Rejected: ${body.method} requires session (must initialize first)`);
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Initialize request required to create session'
            },
            id: body.id ?? null
          });
          return;
        }
      }
      // EXISTING SESSION: Validate and use
      else if (!transport) {
        console.error(`[HTTP] ❌ Invalid session ID: ${sessionId || 'missing'}`);
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Invalid or missing session ID'
          },
          id: req.body?.id ?? null
        });
        return;
      }

      // Log MCP method calls
      if (req.method === 'POST' && req.body?.method) {
        const method = req.body.method;
        const params = req.body.params;
        if (method === 'tools/list') {
          console.error(`[HTTP] 📋 Session ${sessionId}: tools/list`);
        } else if (method === 'tools/call') {
          const toolName = params?.name || 'unknown';
          console.error(`[HTTP] 🔧 Session ${sessionId}: tools/call -> ${toolName}`);
        } else if (method !== 'initialize') {
          console.error(`[HTTP] 📨 Session ${sessionId}: ${method}`);
        }
      } else if (req.method === 'GET') {
        console.error(`[HTTP] 🔄 Session ${sessionId}: SSE stream request`);
      } else if (req.method === 'DELETE') {
        console.error(`[HTTP] 🗑️  Session ${sessionId}: DELETE (closing)`);
      }

      // Handle the request (transport handles GET/POST/DELETE automatically)
      await transport.handleRequest(req, res, req.body);

    } catch (error) {
      console.error('[HTTP] Error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal error',
            data: error instanceof Error ? error.message : String(error)
          },
          id: req.body?.id ?? null
        });
      }
    }
  });

  // Start server
  return new Promise((resolve, reject) => {
    const server = app.listen(options.port, options.host, () => {
      console.error(`✅ Salesforce MCP Server v${options.config.version} running on http://${options.host}:${options.port}`);
      console.error(`   Health check: http://${options.host}:${options.port}/health`);
      console.error(`   MCP endpoint: http://${options.host}:${options.port}/mcp`);
      console.error(`   Transport: StreamableHTTP with SSE`);
      resolve();
    });

    server.on('error', (error) => {
      console.error('[HTTP] Server error:', error);
      reject(error);
    });
  });
}
