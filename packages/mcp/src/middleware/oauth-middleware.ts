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
 * - Discovery operations: tools/list (skipped, no auth), resources/*, prompts/*
 * - Protocol notifications: notifications/* (initialized, cancelled, progress, message)
 *
 * Auth Required (User Operations):
 * - Tool execution: tools/call (accesses user's Salesforce org)
 *
 * Security:
 * - Tokens are NEVER logged (only their length for debugging)
 * - Returns JSON-RPC 2.0 error responses for auth failures
 * - Each request is isolated
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
    console.error(`[OAuth Middleware] [OAUTH-DEBUG] Skipping auth for GET request (SSE stream)`);
    console.error(`[OAuth Middleware] [OAUTH-DEBUG] GET headers: session=${req.headers['mcp-session-id']}, auth=${req.headers['authorization'] ? 'present' : 'MISSING'}`);
    return next();
  }

  const requestId = req.body?.id ?? 'unknown';
  const method = req.body?.method;

  console.error(`[OAuth Middleware] [Request ${requestId}]  Validating auth for method: ${method || 'undefined'}`);

  // Skip auth for POST requests with no method (OAuth detection probes)
  // LibreChat sends POST with empty body {} to detect OAuth requirement
  if (!method) {
    console.error(`[OAuth Middleware] [Request ${requestId}]   Skipping auth for empty/invalid request (OAuth detection)`);
    return next();
  }

  // Skip auth ONLY for protocol handshake methods
  // NOTE: tools/list is skipped and does not require auth
  const skipAuthMethods = ['initialize', 'ping', 'tools/list'];

  // Skip auth for resource/prompt discovery
  const isListOperation = method && (
    method.startsWith('resources/') ||  // resources/list, resources/templates/list, etc.
    method.startsWith('prompts/')       // prompts/list, prompts/get, etc.
  );

  // Skip auth for all notification methods (protocol lifecycle)
  const isNotification = method && method.startsWith('notifications/');

  if (skipAuthMethods.includes(method) || isListOperation || isNotification) {
    console.error(`[OAuth Middleware] [Request ${requestId}]   Skipping auth for method: ${method}`);
    return next();
  }

  const authHeader = getHeaderValue(req, 'authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error(`[OAuth Middleware] [Request ${requestId}]  Missing or invalid Authorization header`);

    const baseUrl = `http://${req.get('host')}`;
    const wwwAuth = `Bearer error="invalid_token", error_description="OAuth authentication required. To resolve: authenticate via your MCP client. Your client should redirect to Salesforce OAuth.", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;

    console.error(`[OAuth Middleware] [Request ${requestId}]  Returning 401 Unauthorized (LibreChat OAuth detection)`);
    console.error(`[OAuth Middleware] [Request ${requestId}]  [OAUTH-DEBUG] HTTP method: ${req.method}, MCP method: ${method}`);
    console.error(`[OAuth Middleware] [Request ${requestId}]  [OAUTH-DEBUG] About to send 401 response...`);

    // Return error format that matches LibreChat's isOAuthError() checks:
    // - code: 401 or 403
    // - message containing: '401', 'invalid_token', 'unauthorized', 'authentication required'
    res.status(401);
    res.setHeader('WWW-Authenticate', wwwAuth);
    res.setHeader('Content-Type', 'application/json');
    const body = JSON.stringify({
      code: 401,
      message: 'Unauthorized: invalid_token - OAuth authentication required',
      error: 'invalid_token',
      error_description: 'OAuth authentication required'
    });
    console.error(`[OAuth Middleware] [Request ${requestId}]  [OAUTH-DEBUG] Sending body: ${body}`);
    res.end(body);
    console.error(`[OAuth Middleware] [Request ${requestId}]  [OAUTH-DEBUG] 401 response sent and ended`);
    return;
  }

  // Extract token (never log the actual token)
  const accessToken = authHeader.substring(7).trim();

  if (!accessToken) {
    console.error(`[OAuth Middleware] [Request ${requestId}]  Empty Bearer token`);
    console.error(`[OAuth Middleware] [Request ${requestId}]  Returning 401 Unauthorized (LibreChat OAuth detection)`);

    return res
      .status(401)
      .setHeader('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Bearer token is empty"')
      .json({
        code: 401,
        message: 'Unauthorized: invalid_token - Bearer token is empty',
        error: 'invalid_token',
        error_description: 'Bearer token is empty'
      });
  }

  // Log success
  console.error(`[OAuth Middleware] [Request ${requestId}] Bearer token validated`);

  next();
}
