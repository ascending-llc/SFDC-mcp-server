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
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Toolset } from '@salesforce/mcp-provider-api';
import { SfMcpServer } from './sf-mcp-server.js';
import { Services } from './services.js';
import { registerToolsets } from './utils/registry-utils.js';
import Cache from './utils/cache.js';
import cors from 'cors';
import helmet from 'helmet';
import { salesforceOAuthMiddleware } from './middleware/oauth-middleware.js';

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
  console.error('[HTTP] ⚠️  Multi-tenant isolation via AsyncLocalStorage per-request');

  // Health check endpoint
  app.get('/', (_req, res) => {
    const healthData = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      transport: 'streamable-http-stateless',
      mode: 'stateless'
    };
    console.error(`[HTTP] Health check - stateless mode`);
    res.json(healthData);
  });

  app.post('/', (_req, res) => {
    const healthData = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      transport: 'streamable-http-stateless',
      mode: 'stateless'
    };
    console.error(`[HTTP] Health check (POST) - stateless mode`);
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
  const oauthDiscoveryHandler = (req: express.Request, res: express.Response) => {
    const authHeader = req.headers['authorization'];

    // If client already has a Bearer token, return 404 to indicate OAuth isn't needed
    // This prevents VS Code from starting OAuth flow when a static token is configured
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      console.error('[OAuth Discovery] ════════════════════════════════════════');
      console.error('[OAuth Discovery] Client already has Bearer token - skipping OAuth discovery');
      console.error('[OAuth Discovery] Returning 404 to use existing token');
      console.error('[OAuth Discovery] ════════════════════════════════════════');
      return res.status(404).json({
        error: 'not_found',
        error_description: 'OAuth discovery not needed - Bearer token already provided'
      });
    }

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
    console.error('[OAuth Discovery] Path:', req.path);
    console.error('[OAuth Discovery] Client:', req.headers['user-agent'] || 'unknown');
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
  app.all('/mcp', salesforceOAuthMiddleware, async (req, res) => {
    try {
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

      // Log MCP method calls
      if (req.method === 'POST' && req.body?.method) {
        const method = req.body.method;
        const params = req.body.params;
        if (method === 'tools/list') {
          console.error(`[HTTP]  Stateless: tools/list`);
        } else if (method === 'tools/call') {
          const toolName = params?.name || 'unknown';
          console.error(`[HTTP]  Stateless: tools/call -> ${toolName}`);
        } else {
          console.error(`[HTTP]  Stateless: ${method}`);
        }
      }

      // Handle the request (stateless transport shared across all clients)
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
      console.error(`   Transport: StreamableHTTP with SSE (stateless)`);
      resolve();
    });

    server.on('error', (error) => {
      console.error('[HTTP] Server error:', error);
      reject(error);
    });
  });
}
