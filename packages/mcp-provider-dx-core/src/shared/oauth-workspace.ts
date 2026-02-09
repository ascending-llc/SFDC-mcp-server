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
 * Helper to resolve directory parameter in OAuth mode vs CLI mode.
 *
 * In CLI mode:
 * - User provides actual project directory path
 * - SfProject.resolve() works with their local filesystem
 *
 * In OAuth mode:
 * - No real filesystem, need per-user temporary workspace
 * - This helper would call workspace manager to get/create workspace
 *
 * Future Enhancement:
 * Import and use workspace-manager here when implementing full OAuth workspace support.
 *
 * For now, this is a placeholder to show where the integration would happen.
 */

/**
 * Resolves the directory to use for tool execution.
 * 
 * @param inputDirectory - Directory from tool parameters
 * @returns Actual directory to use (OAuth workspace or CLI directory)
 */
export async function resolveWorkingDirectory(inputDirectory: string): Promise<string> {
  // TODO: Detect if in OAuth mode
  // const isOAuthMode = hasOAuthContext(); // from auth-helper
  
  // if (isOAuthMode) {
  //   const workspace = await getOrCreateUserWorkspace(); // from workspace-manager
  //   if (workspace) return workspace;
  // }
  
  // CLI mode: use provided directory
  return inputDirectory;
}
