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
import { AsyncLocalStorage } from 'node:async_hooks';
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';

export interface RequestContext {
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>;
  transportMode: 'http' | 'stdio';
  requestId?: string;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function runWithContext<T>(
  context: RequestContext,
  fn: () => T | Promise<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    requestContextStorage.run(context, async () => {
      try {
        const result = await fn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Shims process.chdir() to be a no-op in OAuth-only HTTP mode.
 *
 * Why this is needed:
 * - Tools may call process.chdir(input.directory) expecting to change working directory
 * - In OAuth-only cloud deployment, there's no personal filesystem or project directories
 * - Multi-tenant mode means shared working directory would be unsafe
 * - Some Salesforce SDK APIs internally call process.chdir() for .sf/ directory discovery
 *
 * This shim prevents crashes while maintaining backward compatibility with tools
 * that were designed for CLI mode.
 *
 * Security:
 * - Always no-op (never actually changes directory)
 * - Logs attempted directory changes for debugging
 * - Multi-tenant safe (no shared state)
 *
 * Call this function early in server startup (index.ts or http-server.ts).
 */
export function installChdirShim(): void {
  const originalChdir = process.chdir;

  // Store original for potential restoration
  (process as any).__originalChdir = originalChdir;

  // Replace with no-op shim
  process.chdir = function shimmedChdir(directory: string | URL): void {
    const dirStr = typeof directory === 'string' ? directory : directory.toString();
    console.error(`[Chdir Shim] ⏭️  No-op chdir (OAuth-only mode): ${dirStr}`);

    // Always no-op - do not call originalChdir
    // This is intentional for OAuth-only HTTP mode
    return;
  };

  console.error(`[Chdir Shim] ✅ Installed chdir shim (OAuth-only mode)`);
}
