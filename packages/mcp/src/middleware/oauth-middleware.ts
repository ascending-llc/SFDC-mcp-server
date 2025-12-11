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

import { Request, Response, NextFunction } from 'express';
import { SalesforceAuthContext } from '../types/auth-context.js';

/**
 * Helper to normalize header values (handles string | string[] types)
 */
function getHeaderValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Salesforce OAuth middleware - extracts Bearer token from Authorization header (stateless)
 *
 * LibreChat sends the Salesforce OAuth token on every request, so we extract it per-request
 * and attach to req.salesforceAuth for tools to access. No session storage needed.
 *
 * Flow:
 * 1. LibreChat user authenticates to Salesforce via OAuth
 * 2. LibreChat stores token securely
 * 3. On each MCP request, LibreChat sends: Authorization: Bearer <token>
 * 4. This middleware extracts token and attaches to request
 * 5. Tools access via getAuthContext(extra) helper
 */
export function salesforceOAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  // Skip authentication for GET requests (used for SSE - Server-Sent Events)
  if (req.method === 'GET') {
    console.error(`[OAuth Middleware] ⏭️  Skipping auth for GET request (SSE)`);
    return next();
  }

  // Skip authentication for MCP protocol methods (don't require Salesforce access)
  const skipAuthMethods = ["ping", "initialize"];

  const method = req.body?.method;
  const requestId = req.body?.id ?? 'unknown';

  if (skipAuthMethods.includes(method)) {
    console.error(`[OAuth Middleware] [Request ${requestId}] ⏭️  Skipping auth for protocol method: ${method}`);
    return next();
  }

  console.error(`[OAuth Middleware] [Request ${requestId}] 🔐 Validating auth for method: ${method}`);

  // Log header presence for debugging
  const authHeaderPresent = !!req.headers['authorization'];
  const instanceUrlPresent = !!req.headers['x-salesforce-instance-url'];
  console.error(
    `[OAuth Middleware] [Request ${requestId}] 📋 Headers present - Authorization: ${authHeaderPresent}, X-Salesforce-Instance-URL: ${instanceUrlPresent}`
  );

  // Extract Bearer token from Authorization header (normalize string | string[])
  const authHeader = getHeaderValue(req, 'authorization');

  if (!authHeader) {
    console.error(`[OAuth Middleware] [Request ${requestId}] ❌ Missing Authorization header`);
    return res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Missing Authorization header. Please authenticate with Salesforce.'
      },
      id: requestId
    });
  }

  if (!authHeader.startsWith('Bearer ')) {
    console.error(`[OAuth Middleware] [Request ${requestId}] ❌ Invalid Authorization header format (expected "Bearer <token>")`);
    return res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Invalid Authorization header format. Expected "Bearer <token>".'
      },
      id: requestId
    });
  }

  const accessToken = authHeader.substring(7).trim(); // Remove "Bearer "

  console.error(
    `[OAuth Middleware] [Request ${requestId}] ✅ Bearer token extracted successfully (length: ${accessToken.length})`
  );

  if (!accessToken) {
    console.error(`[OAuth Middleware] [Request ${requestId}] ❌ Empty access token in Authorization header`);
    return res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Empty access token'
      },
      id: requestId
    });
  }

  // Extract instance URL from custom header (normalize string | string[])
  // NOTE: This header is now OPTIONAL. If missing, tools will derive instance URL
  // from token via userinfo API (stateless introspection).
  const instanceUrl = getHeaderValue(req, 'x-salesforce-instance-url');

  if (instanceUrl) {
    console.error(`[OAuth Middleware] [Request ${requestId}] ✅ Auth validated with instance URL: ${instanceUrl}`);
  } else {
    console.error(`[OAuth Middleware] [Request ${requestId}] ✅ Auth validated (instance URL will be derived from token)`);
  }

  // Attach minimal auth context to request (backward compatibility)
  // Note: Tools should use extra.requestInfo.headers instead
  const authContext: SalesforceAuthContext = {
    accessToken,
    instanceUrl: instanceUrl || undefined,
    userId: undefined
  };

  (req as any).salesforceAuth = authContext;

  console.error(
    `[OAuth Middleware] [Request ${requestId}] ✅ Auth context attached to request:`,
    {
      hasAccessToken: !!authContext.accessToken,
      tokenLength: authContext.accessToken?.length,
      instanceUrl: authContext.instanceUrl || 'to-be-derived',
      hasUserId: !!authContext.userId
    }
  );

  next();
}

