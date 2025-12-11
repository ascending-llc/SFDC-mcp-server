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

/**
 * Stateless OAuth authentication context - extracted per-request
 * LibreChat sends Bearer token on every request, so no storage needed
 */
export interface SalesforceAuthContext {
  /** OAuth access token from LibreChat */
  accessToken: string;
  /**
   * Salesforce instance URL (e.g., https://na1.salesforce.com)
   * Optional - will be derived from token via userinfo API if not provided
   */
  instanceUrl?: string;
  /** Optional user ID from token introspection */
  userId?: string;
}

/**
 * Type guard to check if auth context is present
 */
export function hasSalesforceAuth(obj: any): obj is { salesforceAuth: SalesforceAuthContext } {
  return obj && typeof obj.salesforceAuth === 'object'
    && typeof obj.salesforceAuth.accessToken === 'string';
}
