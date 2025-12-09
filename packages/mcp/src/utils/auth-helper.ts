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

import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { AuthInfo, Connection } from '@salesforce/core';
import { SalesforceAuthContext } from '../types/auth-context.js';

/**
 * Helper to normalize header values (handles string | string[] types)
 */
function getHeaderValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Derive instance URL from Salesforce access token via userinfo endpoint
 *
 * STATELESS: No caching. Calls userinfo API on every invocation.
 *
 * Calls https://login.salesforce.com/services/oauth2/userinfo to get user info,
 * which includes the instance URL in the urls.rest field.
 *
 * @param accessToken - Salesforce OAuth access token
 * @returns Instance URL (e.g., "https://na1.salesforce.com") or undefined if failed
 */
async function deriveInstanceUrlFromToken(accessToken: string): Promise<string | undefined> {
  try {
    console.error(`[OAuth] 🔍 Deriving instance URL from token via userinfo endpoint (stateless)`);

    // Call Salesforce userinfo endpoint
    const response = await fetch('https://login.salesforce.com/services/oauth2/userinfo', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.error(`[OAuth] ❌ Userinfo call failed: ${response.status} ${response.statusText}`);
      return undefined;
    }

    const userInfo = await response.json();

    // Extract instance URL from urls.rest field
    // Format: "https://na1.salesforce.com/services/data/v60.0/"
    const restUrl = userInfo.urls?.rest;
    if (!restUrl) {
      console.error(`[OAuth] ❌ No rest URL in userinfo response`);
      return undefined;
    }

    // Parse instance URL from rest URL
    const url = new URL(restUrl);
    const instanceUrl = `${url.protocol}//${url.host}`;

    console.error(`[OAuth] ✅ Derived instance URL: ${instanceUrl}`);

    return instanceUrl;
  } catch (error) {
    console.error(`[OAuth] ❌ Error deriving instance URL:`, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/**
 * Extract Salesforce auth context from MCP request extra parameter
 *
 * The StreamableHTTPServerTransport passes request headers through as extra.requestInfo.headers.
 * This helper extracts the OAuth token from the Authorization header and instance URL
 * from either:
 * 1. X-Salesforce-Instance-URL header (if provided)
 * 2. Token introspection via Salesforce userinfo API (if header missing)
 *
 * Flow:
 * 1. LibreChat sends: Authorization: Bearer <token>
 * 2. OAuth middleware validates Authorization header
 * 3. StreamableHTTPServerTransport passes headers as extra.requestInfo.headers
 * 4. This helper extracts token and derives instance URL if needed
 *
 * @param extra - The extra parameter passed to tool.exec()
 * @returns Promise resolving to Salesforce auth context if available, undefined otherwise
 */
export async function getAuthContext(
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<SalesforceAuthContext | undefined> {
  // Extract headers from MCP SDK's requestInfo structure
  const headers = extra?.requestInfo?.headers;

  if (!headers) {
    return undefined;
  }

  // Extract Bearer token from Authorization header (normalize string | string[])
  const authHeader = getHeaderValue(headers, 'authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return undefined;
  }

  const accessToken = authHeader.substring(7).trim(); // Remove "Bearer "
  if (!accessToken) {
    return undefined;
  }

  // Try to extract instance URL from custom header first (fast path)
  let instanceUrl = getHeaderValue(headers, 'x-salesforce-instance-url');

  // If no header provided, derive from token via userinfo API (slow path)
  if (!instanceUrl) {
    console.error(`[OAuth] ⚠️  X-Salesforce-Instance-URL header missing, deriving from token`);
    instanceUrl = await deriveInstanceUrlFromToken(accessToken);

    if (!instanceUrl) {
      console.error(`[OAuth] ❌ Failed to derive instance URL from token`);
      return undefined;
    }
  } else {
    console.error(`[OAuth] ✅ Using instance URL from header: ${instanceUrl}`);
  }

  // At this point, instanceUrl is guaranteed to be defined (either from header or derived)
  return {
    accessToken,
    instanceUrl: instanceUrl!, // Non-null assertion safe here - we checked above
    userId: undefined
  };
}

/**
 * Create a Salesforce Connection using OAuth token from request context
 *
 * @param extra - The extra parameter passed to tool.exec()
 * @returns Connection configured with OAuth token, or undefined if no auth context
 */
export async function createOAuthConnection(
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<Connection | undefined> {
  const authContext = await getAuthContext(extra);

  if (!authContext) {
    return undefined;
  }

  // Create AuthInfo from OAuth access token (in-memory, not persisted)
  // accessTokenOptions is designed for already-issued tokens from external OAuth flows
  const authInfo = await AuthInfo.create({
    username: 'oauth-user', // Placeholder; not persisted
    accessTokenOptions: {
      accessToken: authContext.accessToken,
      instanceUrl: authContext.instanceUrl,
    },
  });

  // Create Salesforce Connection with AuthInfo
  const connection = await Connection.create({ authInfo });

  console.error(`[OAuth] ✅ Created connection to ${authContext.instanceUrl}`);

  return connection;
}

/**
 * Check if OAuth authentication is available in the request context
 *
 * @param extra - The extra parameter passed to tool.exec()
 * @returns Promise resolving to true if OAuth auth context is present, false otherwise
 */
export async function hasOAuthContext(
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<boolean> {
  const authContext = await getAuthContext(extra);
  return authContext !== undefined;
}
