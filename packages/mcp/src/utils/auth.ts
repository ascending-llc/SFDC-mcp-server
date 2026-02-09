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

import { type Connection, type OrgAuthorization } from '@salesforce/core';
import { type SanitizedOrgAuthorization } from '@salesforce/mcp-provider-api';
import { createOAuthConnection } from './auth-helper.js';

/**
 * Sanitizes org authorization data by filtering out sensitive fields
 *
 * @param orgs - Array of OrgAuthorization objects
 * @returns Array of sanitized org authorization objects with only allowed fields
 */
export function sanitizeOrgs(orgs: OrgAuthorization[]): SanitizedOrgAuthorization[] {
  return orgs.map((org) => ({
    aliases: org.aliases,
    configs: org.configs,
    username: org.username,
    instanceUrl: org.instanceUrl,
    isScratchOrg: org.isScratchOrg,
    isDevHub: org.isDevHub,
    isSandbox: org.isSandbox,
    orgId: org.orgId,
    oauthMethod: org.oauthMethod,
    isExpired: org.isExpired,
  }));
}

/**
 * Gets a Salesforce connection using OAuth authentication from AsyncLocalStorage.
 *
 * OAuth-Only Mode:
 * This function ONLY supports OAuth authentication via AsyncLocalStorage.
 * CLI-based authentication (sf org display) is NOT supported.
 *
 * The server is designed for multi-tenant cloud deployment where:
 * - Each user authenticates with their own OAuth token (Authorization: Bearer <token>)
 * - No local filesystem access to .sf/ directory or CLI credentials
 * - Stateless per-request authentication
 *
 * Architecture:
 * 1. HTTP request arrives with Authorization: Bearer <token> header
 * 2. OAuth middleware validates the token
 * 3. MCP SDK creates RequestHandlerExtra with headers
 * 4. sf-mcp-server.ts wrapper stores context in AsyncLocalStorage
 * 5. THIS FUNCTION reads OAuth from AsyncLocalStorage and creates connection
 *
 * Multi-Tenant Safety:
 * - Each request has isolated AsyncLocalStorage context
 * - No shared state between users
 * - Each user's OAuth token creates independent connection
 *
 * @param username - Username or alias (not used in OAuth-only mode, kept for backward compatibility)
 * @returns Salesforce Connection authenticated with OAuth token
 * @throws Error if OAuth context not available in AsyncLocalStorage
 */
export async function getConnection(username: string): Promise<Connection> {
  console.error(`[Auth]  getConnection called for username: ${username}`);

  // OAuth-only mode - check AsyncLocalStorage for OAuth context
  const oauthConnection = await createOAuthConnection();

  if (!oauthConnection) {
    const errorMsg =
      'OAuth authentication required. No OAuth context found in request. ' +
      'Please ensure Authorization: Bearer <token> header is provided. ' +
      'CLI-based authentication is not supported in OAuth-only mode.';
    console.error(`[Auth]  ${errorMsg}`);
    throw new Error(errorMsg);
  }

  console.error(`[Auth]  Using OAuth connection from AsyncLocalStorage`);
  return oauthConnection;
}

/*
 * ============================================================================
 * LEGACY CLI AUTH FUNCTIONS - NOT USED IN OAUTH-ONLY MODE
 * ============================================================================
 *
 * The functions below were used for CLI-based authentication (sf org display).
 * They are commented out because the server now operates in OAuth-only mode
 * for multi-tenant cloud deployment.
 *
 * Kept for reference in case hybrid auth mode is needed in the future.
 * ============================================================================
 */

/*
export function findOrgByUsernameOrAlias(
  allOrgs: SanitizedOrgAuthorization[],
  usernameOrAlias: string
): SanitizedOrgAuthorization | undefined {
  return allOrgs.find((org) => {
    const isMatchingUsername = org.username === usernameOrAlias;
    const isMatchingAlias = org.aliases && Array.isArray(org.aliases) && org.aliases.includes(usernameOrAlias);
    return isMatchingUsername || isMatchingAlias;
  });
}

export async function getAllAllowedOrgs(): Promise<SanitizedOrgAuthorization[]> {
  const orgAllowList = (await Cache.safeGet('allowedOrgs')) ?? new Set<string>();
  const allOrgs = await AuthInfo.listAllAuthorizations();
  const sanitizedOrgs = sanitizeOrgs(allOrgs);
  const allowedOrgs = await filterAllowedOrgs(sanitizedOrgs, orgAllowList);
  return allowedOrgs;
}

export async function filterAllowedOrgs(
  orgs: SanitizedOrgAuthorization[],
  allowList: Set<string>
): Promise<SanitizedOrgAuthorization[]> {
  if (allowList.has('ALLOW_ALL_ORGS')) return orgs;

  const defaultTargetOrg = await getDefaultTargetOrg();
  const defaultTargetDevHub = await getDefaultTargetDevHub();

  return orgs.filter((org) => {
    if (!org.username) return false;
    if (allowList.has(org.username)) return true;
    if (org.aliases?.some((alias) => allowList.has(alias))) return true;

    if (allowList.has('DEFAULT_TARGET_ORG') && defaultTargetOrg?.value) {
      if (org.username === defaultTargetOrg.value) return true;
      if (org.aliases?.includes(defaultTargetOrg.value)) return true;
    }

    if (allowList.has('DEFAULT_TARGET_DEV_HUB') && defaultTargetDevHub?.value) {
      if (org.username === defaultTargetDevHub.value) return true;
      if (org.aliases?.includes(defaultTargetDevHub.value)) return true;
    }

    return false;
  });
}

async function getDefaultConfig(
  property: OrgConfigProperties.TARGET_ORG | OrgConfigProperties.TARGET_DEV_HUB
): Promise<OrgConfigInfo | undefined> {
  await ConfigAggregator.clearInstance();
  const aggregator = await ConfigAggregator.create();
  const config = aggregator.getInfo(property);
  const { value, path, key, location } = config;
  if (!value || typeof value !== 'string' || !path) return undefined;
  return { key, location, value, path } as OrgConfigInfo;
}

export async function getDefaultTargetOrg(): Promise<OrgConfigInfo | undefined> {
  return getDefaultConfig(OrgConfigProperties.TARGET_ORG);
}

export async function getDefaultTargetDevHub(): Promise<OrgConfigInfo | undefined> {
  return getDefaultConfig(OrgConfigProperties.TARGET_DEV_HUB);
}
*/
