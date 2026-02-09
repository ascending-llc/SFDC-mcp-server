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
import Cache from './utils/cache.js';
import cors from 'cors';
import helmet from 'helmet';
import { salesforceOAuthMiddleware } from './middleware/oauth-middleware.js';

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
  apiOnly: boolean,
  services: Services
): Promise<SfMcpServer> {
  const server = new SfMcpServer(config, options);

  // Register toolsets for this server instance
  await registerToolsets(toolsets, tools, dynamicTools, allowNonGaTools, apiOnly, server, services);

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
  apiOnly: boolean;
  allowedOrgs: Set<string>;
  services: Services;
}): Promise<void> {
  const app = express();

  // Middleware
  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  // Request logging middleware with auth logging
  app.use((req, _res, next) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ${req.method} ${req.path} - Session: ${req.headers['mcp-session-id'] || 'none'}`);

    // Log OAuth token presence (never log the actual token)
    const authHeader = req.headers['authorization'];
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const tokenLength = authHeader.substring(7).length;
      console.error(`[HTTP]  Bearer token present (length: ${tokenLength})`);
    }

    next();
  });

  // Health check endpoint
  app.get('/', (_req, res) => {
    const healthData = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      transport: 'streamable-http',
      sessions: transports.size
    };
    console.error(`[HTTP] Health check - ${transports.size} active sessions`);
    res.json(healthData);
  });

  app.post('/', (_req, res) => {
    const healthData = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      transport: 'streamable-http',
      sessions: transports.size
    };
    console.error(`[HTTP] Health check (POST) - ${transports.size} active sessions`);
    res.json(healthData);
  });

  // OAuth Protected Resource Metadata - RFC 9728
  // Tells jarvis that this server requires OAuth and where to get tokens
  app.get('/.well-known/oauth-protected-resource', (req, res) => {
    const salesforceAuthServer = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

    // Use localhost for resource URL instead of 0.0.0.0 (which is not a valid client URL)
    const resourceHost = options.host === '0.0.0.0' ? 'localhost' : options.host;

    const metadata = {
      resource: `http://${resourceHost}:${options.port}`,
      authorization_servers: [salesforceAuthServer],
      scopes_supported: ['full'],
      bearer_methods_supported: ['header'],
      resource_documentation: 'https://github.com/salesforcecli/mcp'
    };

    console.error('[OAuth Discovery] ════════════════════════════════════════');
    console.error('[OAuth Discovery] RFC 9728 metadata requested');
    console.error('[OAuth Discovery] Client:', req.headers['user-agent'] || 'unknown');
    console.error('[OAuth Discovery] Returning:', JSON.stringify(metadata, null, 2));
    console.error('[OAuth Discovery] ════════════════════════════════════════');

    res.json(metadata);
  });

  // Main MCP endpoint - handles GET (SSE), POST (requests), DELETE (cleanup)
  // OAuth middleware validates Bearer token for tool calls (skips initialize/ping/tools/list)
  app.all('/mcp', salesforceOAuthMiddleware, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      let transport = sessionId ? transports.get(sessionId) : undefined;

      // DEBUG: Log session lookup
      console.error(`[HTTP] [OAUTH-DEBUG] Session lookup: sessionId=${sessionId || 'none'}, found=${!!transport}, transportsMapSize=${transports.size}`);
      if (sessionId && !transport) {
        console.error(`[HTTP] [OAUTH-DEBUG] WARNING: Session ID provided but not found in transports map!`);
        console.error(`[HTTP] [OAUTH-DEBUG] Available sessions: ${Array.from(transports.keys()).join(', ') || 'none'}`);
      }

      // Handle HEAD requests for OAuth detection (LibreChat 401 Challenge Method)
      if (req.method === 'HEAD') {
        console.error('[OAuth Detection] ════════════════════════════════════════');
        console.error('[OAuth Detection] HEAD request for 401 challenge detection');
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          console.error('[OAuth Detection] No auth header - returning 401 challenge');
          const baseUrl = `http://${req.get('host')}`;
          const wwwAuth = `Bearer error="invalid_token", error_description="OAuth authentication required", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;
          console.error('[OAuth Detection] WWW-Authenticate:', wwwAuth);
          console.error('[OAuth Detection] ════════════════════════════════════════');
          return res
            .status(401)
            .setHeader('WWW-Authenticate', wwwAuth)
            .end();
        }
        console.error('[OAuth Detection] Auth header present - returning 200');
        console.error('[OAuth Detection] ════════════════════════════════════════');
        return res.status(200).end();
      }

      // NEW SESSION: Initialize request without session ID
      if (!sessionId && req.method === 'POST') {
        const body = req.body;

        // Only create session on initialize request
        if (body.method === 'initialize') {
          console.error(`[HTTP] Incoming initialize request - creating new session`);
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: async (newSessionId) => {
              console.error(`[HTTP] [OAUTH-DEBUG] onsessioninitialized STARTING for: ${newSessionId}`);
              console.error(`[HTTP]  Session initialized: ${newSessionId}`);

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
                options.apiOnly,
                options.services
              );

              mcpServers.set(newSessionId, server);
              transports.set(newSessionId, transport!);
              console.error(`[HTTP] [OAUTH-DEBUG] Session ${newSessionId} stored in transports map, mapSize=${transports.size}`);

              // Connect server to transport
              await server.connect(transport!);
              console.error(`[HTTP] Session ${newSessionId} ready - tools registered`);
              console.error(`[HTTP] [OAUTH-DEBUG] onsessioninitialized COMPLETE for: ${newSessionId}`);
            },
            onsessionclosed: async (closedSessionId) => {
              console.error(`[HTTP]  Session closed: ${closedSessionId}`);
              transports.delete(closedSessionId);
              mcpServers.delete(closedSessionId);
            }
          });
        } else {
          // Invalid or empty request without session - return 401 for OAuth detection
          // LibreChat sends POST with empty body {} to detect OAuth requirement
          console.error('[OAuth Detection] ════════════════════════════════════════');
          console.error('[OAuth Detection] POST with invalid/empty body (OAuth probe)');
          console.error('[OAuth Detection] Body:', JSON.stringify(body));
          console.error('[OAuth Detection] Returning 401 to trigger OAuth flow');
          const baseUrl = `http://${req.get('host')}`;
          const wwwAuth = `Bearer error="invalid_token", error_description="OAuth authentication required. Initialize with valid session first.", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;
          console.error('[OAuth Detection] WWW-Authenticate:', wwwAuth);
          console.error('[OAuth Detection] ════════════════════════════════════════');
          return res
            .status(401)
            .setHeader('WWW-Authenticate', wwwAuth)
            .json({
              code: 401,
              message: 'Unauthorized: OAuth authentication required',
              error: 'invalid_token',
              error_description: 'OAuth authentication required'
            });
        }
      }
      // EXISTING SESSION: Validate and use
      else if (!transport) {
        console.error(`[HTTP]  Invalid session ID: ${sessionId || 'missing'}`);
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
          console.error(`[HTTP]  Session ${sessionId}: tools/list`);
        } else if (method === 'tools/call') {
          const toolName = params?.name || 'unknown';
          console.error(`[HTTP]  Session ${sessionId}: tools/call -> ${toolName}`);
        } else if (method !== 'initialize') {
          console.error(`[HTTP]  Session ${sessionId}: ${method}`);
        }
      } else if (req.method === 'GET') {
        console.error(`[HTTP]  Session ${sessionId}: SSE stream request`);
      } else if (req.method === 'DELETE') {
        console.error(`[HTTP]   Session ${sessionId}: DELETE (closing)`);
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
      console.error(` Salesforce MCP Server v${options.config.version} running on http://${options.host}:${options.port}`);
      console.error(`   Health check: http://${options.host}:${options.port}/`);
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
