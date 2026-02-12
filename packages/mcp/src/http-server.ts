/*
 * Copyright 2026, Salesforce, Inc.
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
/* eslint-disable no-console */

import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Toolset } from '@salesforce/mcp-provider-api';
import { SfMcpServer } from './sf-mcp-server.js';
import { Services } from './services.js';
import { registerToolsets } from './utils/registry-utils.js';
import Cache from './utils/cache.js';
import { salesforceOAuthMiddleware } from './middleware/oauth-middleware.js';
import { Telemetry } from './telemetry.js';

type ServerConfig = {
  name: string;
  version: string;
  capabilities?: Record<string, unknown>;
};

type JsonRpcBody = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
};

/**
 * Create a new MCP server instance for a session
 */
async function createMcpServer(
  config: ServerConfig,
  options: { telemetry?: Telemetry },
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
  config: ServerConfig;
  telemetry?: Telemetry;
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
    console.error(`[${timestamp}] ${req.method} ${req.path} - Session: ${String(req.headers['mcp-session-id'] ?? 'none')}`);

    // Log OAuth token presence (never log the actual token)
    const authHeader = req.headers['authorization'];
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const tokenLength = authHeader.substring(7).length;
      console.error(`[HTTP]  Bearer token present (length: ${tokenLength})`);
    }

    next();
  });

  // STATELESS MODE: Pre-create server and transport at startup
  console.error('[HTTP] Creating stateless server and transport...');

  // Clear tool cache
  await Cache.safeSet('tools', []);
  await Cache.safeSet('allowedOrgs', options.allowedOrgs);

  // Create MCP server with tools registered
  const startTime = Date.now();
  const mcpServer = await createMcpServer(
    options.config,
    { telemetry: options.telemetry },
    options.toolsets,
    options.tools,
    options.dynamicTools,
    options.allowNonGaTools,
    options.apiOnly,
    options.services
  );
  const registrationTime = Date.now() - startTime;
  console.error(`[HTTP] Tool registration took ${registrationTime}ms`);

  // Create stateless transport (no session management)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  // Connect server to transport
  await mcpServer.connect(transport);
  console.error('[HTTP] Stateless server ready - all clients share this instance');
  console.error('[HTTP] Warning: Multi-tenant isolation via AsyncLocalStorage per-request');

  // Health check endpoint
  app.get('/', (_req, res) => {
    const healthData = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      transport: 'streamable-http-stateless',
      mode: 'stateless'
    };
    console.error('[HTTP] Health check - stateless mode');
    res.json(healthData);
  });

  app.post('/', (_req, res) => {
    const healthData = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      transport: 'streamable-http-stateless',
      mode: 'stateless'
    };
    console.error('[HTTP] Health check (POST) - stateless mode');
    res.json(healthData);
  });

  // OAuth Protected Resource Metadata - RFC 9728
  // Tells clients that this server requires OAuth and where to get tokens
  // IMPORTANT: If client already has a Bearer token, return 404 to skip OAuth discovery
  // This allows VS Code/clients with static tokens to use them instead of starting OAuth flow
  //
  // NOTE: This handler is registered at BOTH root and /mcp paths to support:
  //   - Direct connections: /.well-known/oauth-protected-resource
  //   - Gateway proxying: /mcp/.well-known/oauth-protected-resource
  const oauthDiscoveryHandler = (req: express.Request, res: express.Response): void => {
    const authHeader = req.headers['authorization'];

    // If client already has a Bearer token, return 404 to indicate OAuth isn't needed
    // This prevents VS Code from starting OAuth flow when a static token is configured
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      console.error('[OAuth Discovery] ════════════════════════════════════════');
      console.error('[OAuth Discovery] Client already has Bearer token - skipping OAuth discovery');
      console.error('[OAuth Discovery] Returning 404 to use existing token');
      console.error('[OAuth Discovery] ════════════════════════════════════════');
      res.status(404).json({
        error: 'not_found',
        error_description: 'OAuth discovery not needed - Bearer token already provided'
      });
      return;
    }

    const salesforceAuthServer = process.env.SF_LOGIN_URL ?? 'https://login.salesforce.com';

    // Use localhost for resource URL instead of 0.0.0.0 (which is not a valid client URL)
    const resourceHost = options.host === '0.0.0.0' ? 'localhost' : options.host;

    const scheme = req.protocol ?? 'http';
    const metadata = {
      resource: `${scheme}://${resourceHost}:${options.port}`,
      authorization_servers: [salesforceAuthServer],
      scopes_supported: ['full'],
      bearer_methods_supported: ['header'],
      resource_documentation: 'https://github.com/salesforcecli/mcp'
    };

    console.error('[OAuth Discovery] ════════════════════════════════════════');
    console.error('[OAuth Discovery] RFC 9728 metadata requested');
    console.error('[OAuth Discovery] Path:', req.path);
    console.error('[OAuth Discovery] Client:', req.headers['user-agent'] ?? 'unknown');
    console.error('[OAuth Discovery] Returning:', JSON.stringify(metadata, null, 2));
    console.error('[OAuth Discovery] ════════════════════════════════════════');

    res.json(metadata);
  };

  // Register OAuth discovery at root (direct connections)
  app.get('/.well-known/oauth-protected-resource', oauthDiscoveryHandler);

  // Register OAuth discovery under /mcp path (gateway proxying)
  app.get('/mcp/.well-known/oauth-protected-resource', oauthDiscoveryHandler);

  // Main MCP endpoint - handles POST (requests) in stateless mode
  // OAuth middleware validates Bearer token for tool calls (skips initialize/ping/tools/list)
  // eslint-disable-next-line @typescript-eslint/no-misused-promises, complexity
  app.all('/mcp', salesforceOAuthMiddleware, async (req, res) => {
    const body = req.body as JsonRpcBody | undefined;
    try {
      // Log ALL incoming requests with method for debugging
      console.error(`[HTTP] ════ Incoming ${req.method} /mcp ════`);
      console.error(`[HTTP]   Accept: ${String(req.headers.accept ?? 'none')}`);
      console.error(`[HTTP]   Content-Type: ${String(req.headers['content-type'] ?? 'none')}`);
      console.error(`[HTTP]   Session: ${String(req.headers['mcp-session-id'] ?? 'none')}`);

      // Handle OPTIONS requests (CORS preflight)
      if (req.method === 'OPTIONS') {
        console.error('[HTTP] OPTIONS request - CORS preflight');
        return res.status(204).end();
      }

      // Handle DELETE requests (session termination - not used in stateless mode)
      if (req.method === 'DELETE') {
        console.error('[HTTP] DELETE request - session termination not supported in stateless mode');
        return res.status(405).json({
          jsonrpc: '2.0',
          id: 'server-error',
          error: {
            code: -32_600,
            message: 'Method Not Allowed: DELETE not supported in stateless mode'
          }
        });
      }

      // Handle HEAD requests for OAuth detection
      if (req.method === 'HEAD') {
        console.error('[OAuth Detection] ════════════════════════════════════════');
        console.error('[OAuth Detection] HEAD request for 401 challenge detection');
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          console.error('[OAuth Detection] No auth header - returning 401 challenge');
          const scheme = req.protocol ?? 'http';
          const baseUrl = `${scheme}://${String(req.get('host') ?? 'localhost')}`;
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

      // Pre-validate Accept and Content-Type headers before reaching the transport.
      // The TypeScript MCP SDK returns error responses WITHOUT Content-Type header,
      // which causes nginx to return 502 Bad Gateway. By validating here, we can
      // return proper JSON responses with Content-Type that nginx can proxy.
      const acceptHeader = req.headers.accept ?? '';

      if (req.method === 'GET') {
        // GET requests must accept text/event-stream for SSE
        console.error(`[HTTP] GET Accept header: "${acceptHeader}"`);
        if (!acceptHeader.includes('text/event-stream')) {
          console.error('[HTTP] GET request missing Accept: text/event-stream');
          return res.status(406).json({
            jsonrpc: '2.0',
            id: 'server-error',
            error: {
              code: -32_600,
              message: 'Not Acceptable: Client must accept text/event-stream'
            }
          });
        }

        // STATELESS MODE: Handle GET SSE stream without creating a transport.
        // In stateless mode, there are no server-initiated notifications (no session state),
        // so we don't need the full transport machinery. We just:
        // 1. Set up SSE stream with proper headers
        // 2. Send keepalive pings to prevent proxy timeout
        // 3. Clean up when client disconnects
        //
        // This avoids creating orphaned transports that could accumulate.
        console.error('[HTTP] GET request - setting up stateless SSE stream (no transport needed)');

        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.status(200);

        // Send initial ping immediately
        console.error('[HTTP] GET - sending initial SSE ping and starting keepalive');
        res.write(`: ping - ${new Date().toISOString()}\n\n`);

        // Send keepalive pings every 30 seconds to prevent proxy timeout
        const keepaliveInterval = setInterval(() => {
          if (!res.writableEnded) {
            res.write(`: keepalive - ${new Date().toISOString()}\n\n`);
          } else {
            clearInterval(keepaliveInterval);
          }
        }, 30_000);

        // Clean up interval when connection closes
        res.on('close', () => {
          console.error('[HTTP] GET SSE stream closed by client');
          clearInterval(keepaliveInterval);
        });

        res.on('error', (err) => {
          console.error('[HTTP] GET SSE stream error:', err.message);
          clearInterval(keepaliveInterval);
        });

        // Don't end the response - keep SSE stream open for keepalives
        // The client will close when it disconnects
        return;
      }

      if (req.method === 'POST') {
        // POST requests must accept both application/json and text/event-stream
        if (!acceptHeader.includes('application/json') || !acceptHeader.includes('text/event-stream')) {
          console.error('[HTTP] POST request missing required Accept types');
          return res.status(406).json({
            jsonrpc: '2.0',
            id: 'server-error',
            error: {
              code: -32_600,
              message: 'Not Acceptable: Client must accept both application/json and text/event-stream'
            }
          });
        }

        // POST requests must have Content-Type: application/json
        const contentType = req.headers['content-type'] ?? '';
        if (!contentType.includes('application/json')) {
          console.error('[HTTP] POST request missing Content-Type: application/json');
          return res.status(415).json({
            jsonrpc: '2.0',
            id: 'server-error',
            error: {
              code: -32_600,
              message: 'Unsupported Media Type: Content-Type must be application/json'
            }
          });
        }
      }

      // Catch-all for any unhandled methods (PUT, PATCH, etc.)
      if (req.method !== 'POST') {
        console.error(`[HTTP] Unhandled method: ${req.method}`);
        return res.status(405).json({
          jsonrpc: '2.0',
          id: 'server-error',
          error: {
            code: -32_600,
            message: `Method Not Allowed: ${req.method} not supported`
          }
        });
      }

      // Log MCP method calls
      if (body?.method) {
        const method = body.method;
        const params = body.params;
        if (method === 'tools/list') {
          console.error('[HTTP]  Stateless: tools/list');
        } else if (method === 'tools/call') {
          const toolName = (params?.name as string) ?? 'unknown';
          console.error(`[HTTP]  Stateless: tools/call -> ${toolName}`);
        } else {
          console.error(`[HTTP]  Stateless: ${method}`);
        }
      }

      // Handle JSON-RPC notifications (no id field) with proper Content-Type header.
      // The TypeScript SDK returns 202 without Content-Type, which causes nginx 502.
      // Notifications are fire-and-forget, so we just acknowledge receipt.
      // We handle this ourselves instead of passing to transport to ensure proper headers.
      if (body?.method && body?.id === undefined) {
        console.error(`[HTTP] Notification detected: ${body.method} - returning 202 with proper headers`);
        return res.status(202).set('Content-Type', 'application/json').end();
      }

      // Handle POST requests with shared transport (works fine for stateless mode)
      await transport.handleRequest(req, res, req.body);

    } catch (error) {
      console.error('[HTTP] Error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32_603,
            message: 'Internal error',
            data: error instanceof Error ? error.message : String(error)
          },
          id: body?.id ?? null
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
      console.error('   Transport: StreamableHTTP with SSE (stateless)');
      resolve();
    });

    server.on('error', (error) => {
      console.error('[HTTP] Server error:', error);
      reject(error);
    });
  });
}
