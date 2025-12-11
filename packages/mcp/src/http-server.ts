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
const sseStreams = new Map<string, express.Response>(); // Track SSE response objects for keepalive
const sessionActivity = new Map<string, number>(); // Track last activity per session

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
      const now = Date.now();
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
              sessionActivity.set(newSessionId, Date.now());

              // Connect server to transport
              await server.connect(transport!);
              console.error(`[HTTP] Session ${newSessionId} ready - tools registered`);
            },
            onsessionclosed: async (closedSessionId) => {
              console.error(`[HTTP] ❌ Session closed: ${closedSessionId}`);
              transports.delete(closedSessionId);
              mcpServers.delete(closedSessionId);
              sseStreams.delete(closedSessionId);
              sessionActivity.delete(closedSessionId);
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
        if (sessionId) sessionActivity.set(sessionId, now);
      } else if (req.method === 'GET') {
        console.error(`[HTTP] 🔄 Session ${sessionId}: SSE stream request`);
        // Track SSE response object for keepalive
        if (sessionId) {
          sseStreams.set(sessionId, res);
          sessionActivity.set(sessionId, now);
          res.on('close', () => {
            console.error(`[HTTP] SSE stream closed for session ${sessionId} - cleaning up session`);
            sseStreams.delete(sessionId);

            // EXPLICIT SESSION CLEANUP: onsessionclosed callback isn't reliable
            // Clean up all session resources manually
            const hadTransport = transports.has(sessionId);
            const hadServer = mcpServers.has(sessionId);

            transports.delete(sessionId);
            mcpServers.delete(sessionId);
            sessionActivity.delete(sessionId);

            if (hadTransport || hadServer) {
              console.error(`[HTTP] ✅ Manually cleaned up session ${sessionId} (transport: ${hadTransport}, server: ${hadServer})`);
            }
          });
        }
      } else if (req.method === 'DELETE') {
        console.error(`[HTTP] 🗑️  Session ${sessionId}: DELETE (closing) - cleaning up session`);
        // EXPLICIT SESSION CLEANUP on DELETE
        const hadTransport = transports.has(sessionId!);
        const hadServer = mcpServers.has(sessionId!);
        const hadStream = sseStreams.has(sessionId!);

        transports.delete(sessionId!);
        mcpServers.delete(sessionId!);
        sseStreams.delete(sessionId!);
        sessionActivity.delete(sessionId!);

        if (hadTransport || hadServer || hadStream) {
          console.error(`[HTTP] ✅ Manually cleaned up session ${sessionId} on DELETE (transport: ${hadTransport}, server: ${hadServer}, stream: ${hadStream})`);
        }
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

    // SSE keepalive: Send periodic comments to prevent client timeout
    // jarvis-api has a 60-second timeout, so send keepalive every 30 seconds
    const keepaliveIntervalMs = 30000; // 30 seconds (well under 60s client timeout)
    const sessionTtlMs = 5 * 60 * 1000; // prune idle sessions after 5 minutes
    const keepalive = setInterval(() => {
      const activeSessions = sseStreams.size;

      if (activeSessions > 0) {
        console.error(`[HTTP] ❤️  Sending SSE keepalive to ${activeSessions} active stream(s)`);

        // Send SSE comment to each active stream
        for (const [sessionId, stream] of sseStreams.entries()) {
          try {
            // SSE comment format: ": <comment>\n\n"
            // Comments are ignored by clients but keep the connection alive
            const keepaliveComment = ': keepalive\n\n';
            const written = stream.write(keepaliveComment);

            if (written) {
              console.error(`[HTTP] ✅ Sent keepalive to session ${sessionId}`);
            } else {
              console.error(`[HTTP] ⚠️  Stream backpressure for session ${sessionId}`);
            }
          } catch (error) {
            console.error(
              `[HTTP] ❌ Failed to send keepalive to session ${sessionId}:`,
              error instanceof Error ? error.message : String(error)
            );
            // Remove dead stream
            sseStreams.delete(sessionId);
            sessionActivity.delete(sessionId);
          }
        }
      } else {
        console.error(`[HTTP] No active SSE streams`);
      }

      // Prune idle sessions (no activity for TTL)
      const now = Date.now();
      for (const [sessionId, lastSeen] of sessionActivity.entries()) {
        if (now - lastSeen > sessionTtlMs) {
          const hadTransport = transports.delete(sessionId);
          const hadServer = mcpServers.delete(sessionId);
          const hadStream = sseStreams.delete(sessionId);
          sessionActivity.delete(sessionId);
          if (hadTransport || hadServer || hadStream) {
            console.error(
              `[HTTP] 🧹 Pruned idle session ${sessionId} (transport: ${hadTransport}, server: ${hadServer}, stream: ${hadStream})`
            );
          }
        }
      }
    }, keepaliveIntervalMs);

    server.on('error', (error) => {
      console.error('[HTTP] Server error:', error);
      reject(error);
    });

    server.on('close', () => {
      clearInterval(keepalive);
      console.error('[HTTP] Server closed, keepalive stopped');
    });
  });
}
