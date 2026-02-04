/*
 * Copyright (c) 2024, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { Request, Response, NextFunction } from 'express';

/**
 * Helper to extract header value from Express request headers.
 * Express headers can be string | string[] | undefined.
 * Returns the first value if array, or the string if single value.
 */
function getHeaderValue(req: Request, headerName: string): string | undefined {
  const value = req.headers[headerName.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * OAuth middleware for Salesforce MCP Server (HTTP transport).
 *
 * Validates that tool execution includes a valid Authorization: Bearer <token> header.
 *
 * Auth Exemptions (Protocol Discovery/Lifecycle - No User Context Needed):
 * - GET requests (SSE event streams)
 * - Protocol methods: initialize, ping
 * - Discovery operations: tools/list, resources/*, prompts/*
 * - Protocol notifications: notifications/* (initialized, cancelled, progress, message)
 *
 * Auth Required (User Operations):
 * - Tool execution: tools/call (accesses user's Salesforce org)
 *
 * Security:
 * - Tokens are NEVER logged (only their length for debugging)
 * - Returns JSON-RPC 2.0 error responses for auth failures
 * - Each request is isolated (stateless validation)
 *
 * Multi-Tenant:
 * - Each user's OAuth token is validated per-request
 * - No shared state between users
 * - AsyncLocalStorage provides request isolation downstream
 */
export function salesforceOAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void | Response {
  // Skip auth for GET requests (SSE streams)
  if (req.method === 'GET') {
    console.error(`[OAuth Middleware] ⏭️  Skipping auth for GET request (SSE)`);
    return next();
  }

  const requestId = req.body?.id ?? 'unknown';
  const method = req.body?.method;

  console.error(`[OAuth Middleware] [Request ${requestId}] 🔐 Validating auth for method: ${method}`);

  // Debug: Log all headers to see what LibreChat is sending
  if (method === 'tools/call') {
    console.error(`[OAuth Middleware] [Request ${requestId}] 🔍 Headers received:`, JSON.stringify({
      authorization: req.headers.authorization ? `Bearer ***${req.headers.authorization.substring(req.headers.authorization.length - 10)}` : 'MISSING',
      'x-salesforce-instance-url': req.headers['x-salesforce-instance-url'] || 'MISSING',
      'mcp-session-id': req.headers['mcp-session-id'],
      'content-type': req.headers['content-type']
    }, null, 2));
  }

  // Skip auth for protocol discovery/listing methods (no user context needed)
  // NOTE: initialize and ping MUST be allowed without auth (protocol handshake)
  const skipAuthMethods = ['initialize', 'ping'];

  // Skip auth for resource/prompt discovery only
  // NOTE: tools/list is NOT skipped - it must return 401 to trigger LibreChat OAuth flow
  const isListOperation = method && (
    method.startsWith('resources/') ||  // resources/list, resources/templates/list, etc.
    method.startsWith('prompts/')       // prompts/list, prompts/get, etc.
  );

  // Skip auth for all notification methods (protocol lifecycle)
  const isNotification = method && method.startsWith('notifications/');

  if (skipAuthMethods.includes(method) || isListOperation || isNotification) {
    console.error(`[OAuth Middleware] [Request ${requestId}] ⏭️  Skipping auth for method: ${method}`);
    return next();
  }

  // Validate Authorization header
  const authHeader = getHeaderValue(req, 'authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error(`[OAuth Middleware] [Request ${requestId}] ❌ Missing or invalid Authorization header`);

    const baseUrl = `http://${req.get('host')}`;
    const wwwAuth = `Bearer error="invalid_token", error_description="OAuth authentication required. To resolve: authenticate via your MCP client. Your client should redirect to Salesforce OAuth.", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;

    console.error(`[OAuth Middleware] [Request ${requestId}] 🚫 Returning 401 Unauthorized - Plain JSON format (LibreChat OAuth detection)`);
    
    return res
      .status(401)
      .setHeader('WWW-Authenticate', wwwAuth)
      .json({
        error: 'invalid_token',
        error_description: 'OAuth authentication required. To resolve: authenticate via your MCP client. Your client should redirect to Salesforce OAuth.'
      });
  }

  // Extract token (never log the actual token)
  const accessToken = authHeader.substring(7).trim();

  if (!accessToken) {
    console.error(`[OAuth Middleware] [Request ${requestId}] ❌ Empty Bearer token`);
    console.error(`[OAuth Middleware] [Request ${requestId}] 🚫 Returning 401 Unauthorized - Plain JSON format (LibreChat OAuth detection)`);

    return res
      .status(401)
      .setHeader('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Bearer token is empty"')
      .json({
        error: 'invalid_token',
        error_description: 'Bearer token is empty'
      });
  }

  // Log success (token length only - NEVER log the actual token)
  console.error(`[OAuth Middleware] [Request ${requestId}] ✅ Bearer token validated (length: ${accessToken.length})`);

  next();
}
