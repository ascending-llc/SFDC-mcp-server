/*
 * Copyright (c) 2024, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { AuthInfo, Connection } from '@salesforce/core';
import { getRequestContext } from './request-context.js';
import type { SalesforceAuthContext } from '../types/auth-context.js';

const DEFAULT_USERINFO_URL = 'https://login.salesforce.com/services/oauth2/userinfo';

if (!process.env.SF_USERINFO_URL) {
  process.env.SF_USERINFO_URL = DEFAULT_USERINFO_URL;
}

/**
 * Helper to extract header value from MCP SDK headers.
 * Headers from Express are normalized to Record<string, string | string[]>.
 */
function getHeaderValue(
  headers: Record<string, string | string[]> | undefined,
  headerName: string
): string | undefined {
  if (!headers) return undefined;

  const value = headers[headerName.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * Derives Salesforce instance URL from OAuth access token using userinfo API.
 *
 * This is the "slow path" (~200ms) that makes an API call to Salesforce.
 * Prefer using X-Salesforce-Instance-URL header when possible (fast path).
 *
 * @param accessToken - Salesforce OAuth access token
 * @returns Instance URL (e.g., "https://na1.salesforce.com")
 */
async function deriveInstanceUrlFromToken(accessToken: string): Promise<string> {
  console.error(`[OAuth]  Deriving instance URL from token (slow path - userinfo API call)`);

  const userinfoUrl = process.env.SF_USERINFO_URL!;

  try {
    const response = await fetch(userinfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Userinfo API failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { urls?: { custom_domain?: string } };
    const instanceUrl = data?.urls?.custom_domain;

    if (!instanceUrl) {
      throw new Error('Instance URL not found in userinfo response');
    }

    console.error(`[OAuth]  Derived instance URL: ${instanceUrl}`);
    return instanceUrl;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[OAuth]  Failed to derive instance URL: ${errorMsg}`);
    throw new Error(`Failed to derive Salesforce instance URL from token: ${errorMsg}`);
  }
}

/**
 * Extracts Salesforce OAuth authentication context from AsyncLocalStorage.
 *
 * This function reads the RequestContext stored by AsyncLocalStorage and extracts:
 * - OAuth access token from Authorization header
 * - Instance URL from X-Salesforce-Instance-URL header (fast path)
 * - If instance URL not provided, derives it from userinfo API (slow path)
 *
 * Multi-Tenant Safe:
 * - Each request has isolated context in AsyncLocalStorage
 * - No shared state between users
 * - Each user's OAuth token is independent
 *
 * @returns OAuth context with access token and instance URL, or undefined if not available
 */
export async function getAuthContextFromAsyncLocal(): Promise<SalesforceAuthContext | undefined> {
  const ctx = getRequestContext();

  if (!ctx) {
    console.error(`[OAuth]   No request context found in AsyncLocalStorage`);
    return undefined;
  }

  console.error('[OAuth] ════════════════════════════════════════');
  console.error(`[OAuth] Extracting auth context (transport: ${ctx.transportMode}, request: ${ctx.requestId})`);

  const headers = ctx.extra?.requestInfo?.headers as Record<string, string | string[]> | undefined;

  if (!headers) {
    console.error(`[OAuth]   No headers found in request context`);
    return undefined;
  }

  const authHeader = getHeaderValue(headers, 'authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error(`[OAuth]   No Bearer token found in Authorization header`);
    return undefined;
  }

  const accessToken = authHeader.substring(7).trim();

  if (!accessToken) {
    console.error(`[OAuth]   Authorization header has empty Bearer token`);
    return undefined;
  }

  console.error(`[OAuth]  Extracted OAuth token (length: ${accessToken.length} chars)`);

  let instanceUrl = getHeaderValue(headers, 'x-salesforce-instance-url');

  if (instanceUrl) {
    console.error(`[OAuth]  Using instance URL from header: ${instanceUrl}`);
  } else {
    instanceUrl = await deriveInstanceUrlFromToken(accessToken);
  }

  console.error('[OAuth] Auth context extracted successfully');
  console.error('[OAuth] ════════════════════════════════════════');

  return {
    accessToken,
    instanceUrl,
    userId: undefined, // Could be extracted from userinfo API if needed
  };
}

/**
 * Creates a Salesforce connection using OAuth context from AsyncLocalStorage.
 *
 * This is the core function that enables OAuth-only authentication without
 * passing extra parameters through every tool call.
 *
 * Flow:
 * 1. Read OAuth context from AsyncLocalStorage (set by sf-mcp-server.ts wrapper)
 * 2. Create AuthInfo with OAuth access token and instance URL
 * 3. Create and return Connection
 *
 * Multi-Tenant:
 * - Each request has isolated AsyncLocalStorage context
 * - Each user's OAuth token creates independent connection
 * - No shared state between users
 *
 * @returns Salesforce Connection, or undefined if OAuth not available
 */
export async function createOAuthConnection(): Promise<Connection | undefined> {
  const authContext = await getAuthContextFromAsyncLocal();

  if (!authContext) {
    console.error(`[OAuth]   Cannot create OAuth connection - no auth context available`);
    return undefined;
  }

  console.error('[OAuth] ════════════════════════════════════════');
  console.error(`[OAuth] Creating OAuth connection`);
  console.error(`[OAuth] Instance URL: ${authContext.instanceUrl}`);
  console.error(`[OAuth] Token length: ${authContext.accessToken.length} chars`);

  try {
    const authInfo = await AuthInfo.create({
      username: 'oauth-user', // Placeholder - not used for OAuth connections
      accessTokenOptions: {
        accessToken: authContext.accessToken,
        instanceUrl: authContext.instanceUrl,
      },
    });

    const connection = await Connection.create({ authInfo });

    console.error(`[OAuth]  OAuth connection created successfully`);
    console.error(`[OAuth]  Org ID: ${connection.getAuthInfoFields().orgId}`);
    console.error(`[OAuth]  Username: ${connection.getUsername()}`);
    console.error('[OAuth] ════════════════════════════════════════');
    return connection;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[OAuth]  Failed to create OAuth connection: ${errorMsg}`);
    throw new Error(`Failed to create OAuth Salesforce connection: ${errorMsg}`);
  }
}

/**
 * Checks if OAuth context is available in AsyncLocalStorage.
 *
 * This is a lightweight check that doesn't create connections.
 * Useful for logging or conditional logic.
 *
 * @returns true if OAuth context exists, false otherwise
 */
export function hasOAuthContext(): boolean {
  const ctx = getRequestContext();
  if (!ctx) return false;

  const headers = ctx.extra?.requestInfo?.headers as Record<string, string | string[]> | undefined;
  if (!headers) return false;

  const authHeader = getHeaderValue(headers, 'authorization');
  return !!(authHeader && authHeader.startsWith('Bearer '));
}
