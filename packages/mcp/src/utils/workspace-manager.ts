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

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getRequestContext } from './request-context.js';

/**
 * Per-User Workspace Manager for OAuth Mode
 *
 * Creates isolated filesystem workspaces for each OAuth user session.
 * This enables deploy/retrieve tools to work in OAuth mode by providing
 * a minimal sfdx-project.json structure.
 *
 * Architecture:
 * - One workspace per user session
 * - Workspace path: /tmp/sfdc-mcp-{userId}-{sessionId}/
 * - Contains minimal sfdx-project.json + force-app/ directory
 * - Auto-cleanup on session end
 *
 * Multi-Tenant Safe:
 * - Each user has isolated directory
 * - No shared state between users
 * - Session-scoped cleanup
 */

interface WorkspaceInfo {
  path: string;
  userId: string;
  sessionId: string;
  createdAt: Date;
}

// In-memory cache of workspaces (could be Redis in production)
const workspaceCache = new Map<string, WorkspaceInfo>();

/**
 * Minimal sfdx-project.json structure required by SfProject.resolve()
 */
const MINIMAL_SFDX_PROJECT = {
  packageDirectories: [
    {
      path: 'force-app',
      default: true
    }
  ],
  namespace: '',
  sfdcLoginUrl: 'https://login.salesforce.com',
  sourceApiVersion: '62.0'
};

/**
 * Extracts user ID from OAuth context (from access token or headers)
 */
function getUserIdFromContext(): string | undefined {
  const ctx = getRequestContext();
  if (!ctx) return undefined;

  // Try to extract from custom header
  const headers = ctx.extra?.requestInfo?.headers as Record<string, string | string[]> | undefined;
  if (headers) {
    const userId = headers['x-salesforce-user-id'] || headers['x-user-id'];
    if (userId) {
      return Array.isArray(userId) ? userId[0] : userId;
    }
  }

  // Fallback: generate from request ID
  return ctx.requestId;
}

/**
 * Gets or creates a workspace for the current OAuth user session.
 *
 * Flow:
 * 1. Extract user ID from OAuth context
 * 2. Check if workspace already exists for this session
 * 3. If not, create new isolated workspace with sfdx-project.json
 * 4. Return workspace path
 *
 * @returns Absolute path to user's workspace, or undefined if OAuth context not available
 */
export async function getOrCreateUserWorkspace(): Promise<string | undefined> {
  const userId = getUserIdFromContext();
  
  if (!userId) {
    console.error('[Workspace]   No user ID found in OAuth context');
    return undefined;
  }

  // Check cache first
  const cached = workspaceCache.get(userId);
  if (cached) {
    console.error(`[Workspace]  Using cached workspace: ${cached.path}`);
    return cached.path;
  }

  // Create new workspace
  const sessionId = randomUUID().substring(0, 8);
  const workspacePath = join(tmpdir(), `sfdc-mcp-${userId}-${sessionId}`);

  console.error(`[Workspace]  Creating workspace for user ${userId}: ${workspacePath}`);

  try {
    // Create directory structure
    await mkdir(workspacePath, { recursive: true });
    await mkdir(join(workspacePath, 'force-app', 'main', 'default'), { recursive: true });

    // Write minimal sfdx-project.json
    await writeFile(
      join(workspacePath, 'sfdx-project.json'),
      JSON.stringify(MINIMAL_SFDX_PROJECT, null, 2),
      'utf8'
    );

    // Write .forceignore (optional but good practice)
    await writeFile(
      join(workspacePath, '.forceignore'),
      '# Minimal .forceignore\n**/*.dup\n',
      'utf8'
    );

    // Cache workspace info
    const workspaceInfo: WorkspaceInfo = {
      path: workspacePath,
      userId,
      sessionId,
      createdAt: new Date()
    };
    workspaceCache.set(userId, workspaceInfo);

    console.error(`[Workspace]  Workspace created successfully`);
    return workspacePath;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Workspace]  Failed to create workspace: ${errorMsg}`);
    return undefined;
  }
}

/**
 * Cleans up workspace for a specific user.
 * Call this when OAuth session ends or expires.
 */
export async function cleanupUserWorkspace(userId: string): Promise<void> {
  const workspace = workspaceCache.get(userId);
  if (!workspace) {
    console.error(`[Workspace]   No workspace found for user ${userId}`);
    return;
  }

  console.error(`[Workspace]  Cleaning up workspace: ${workspace.path}`);

  try {
    await rm(workspace.path, { recursive: true, force: true });
    workspaceCache.delete(userId);
    console.error(`[Workspace]  Workspace cleaned up successfully`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Workspace]   Failed to cleanup workspace: ${errorMsg}`);
  }
}

/**
 * Cleans up all workspaces older than specified age (in milliseconds).
 * Call this periodically to prevent tmp directory bloat.
 */
export async function cleanupStaleWorkspaces(maxAgeMs: number = 3600000): Promise<void> {
  const now = Date.now();
  const stale: string[] = [];

  for (const [userId, workspace] of workspaceCache.entries()) {
    const age = now - workspace.createdAt.getTime();
    if (age > maxAgeMs) {
      stale.push(userId);
    }
  }

  console.error(`[Workspace]  Cleaning up ${stale.length} stale workspaces`);

  for (const userId of stale) {
    await cleanupUserWorkspace(userId);
  }
}
