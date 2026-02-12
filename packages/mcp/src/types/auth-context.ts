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
