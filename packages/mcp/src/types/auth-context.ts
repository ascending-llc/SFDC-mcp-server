/*
 * Copyright (c) 2024, Salesforce, Inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

/**
 * Salesforce OAuth authentication context.
 *
 * This context is extracted from HTTP request headers and used to create
 * authenticated Salesforce connections in OAuth-only mode.
 *
 * Multi-Tenant:
 * - Each user's OAuth token is isolated per-request
 * - No shared state between users
 * - Stored in AsyncLocalStorage for the duration of the request
 */
export interface SalesforceAuthContext {
  /**
   * Salesforce OAuth access token.
   * Extracted from Authorization: Bearer <token> header.
   */
  accessToken: string;

  /**
   * Salesforce instance URL (e.g., "https://na1.salesforce.com").
   *
   * Optional - can be provided in two ways:
   * 1. Fast path: X-Salesforce-Instance-URL header (preferred)
   * 2. Slow path: Derived from Salesforce userinfo API (~200ms)
   */
  instanceUrl?: string;

  /**
   * Salesforce user ID.
   * Optional - extracted from userinfo API if needed.
   */
  userId?: string;
}
