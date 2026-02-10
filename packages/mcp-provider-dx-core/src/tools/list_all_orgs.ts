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

import { z } from 'zod';
import { McpTool, McpToolConfig, ReleaseState, Services, Toolset } from '@salesforce/mcp-provider-api';
import { CallToolResult, ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { textResponse } from '../shared/utils.js';
import { directoryParam } from '../shared/params.js';

/*
 * List all Salesforce orgs
 *
 * Lists all configured Salesforce orgs.
 *
 * Parameters:
 * - directory: directory to change to before running the command
 *
 * Returns:
 * - textResponse: List of configured Salesforce orgs
 */

export const listAllOrgsParamsSchema = z.object({
  directory: directoryParam,
});

type InputArgs = z.infer<typeof listAllOrgsParamsSchema>;
type InputArgsShape = typeof listAllOrgsParamsSchema.shape;
type OutputArgsShape = z.ZodRawShape;

export class ListAllOrgsMcpTool extends McpTool<InputArgsShape, OutputArgsShape> {
  public constructor(private readonly services: Services) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.ORGS];
  }

  public getName(): string {
    return 'list_all_orgs';
  }

  public getConfig(): McpToolConfig<InputArgsShape, OutputArgsShape> {
    return {
      title: 'List All Orgs',
      description: `Lists all configured Salesforce orgs.

**IMPORTANT - OAuth Mode:**
This tool is NOT APPLICABLE when the server is running in OAuth mode. In OAuth mode, each client connection is authenticated to a single org via bearer token - there is no concept of "multiple orgs" to list. This tool only functions in CLI mode.

**CLI Mode Only - AGENT INSTRUCTIONS:**
DO NOT use this tool to try to determine which org a user wants, use #get_username instead. Only use it if the user explicitly asks for a list of orgs.

Example usage:
Can you list all Salesforce orgs for me
List all Salesforce orgs
List all orgs`,
      inputSchema: listAllOrgsParamsSchema.shape,
      outputSchema: undefined,
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    };
  }

  public async exec(
    input: InputArgs,
    extra?: RequestHandlerExtra<ServerRequest, ServerNotification>
  ): Promise<CallToolResult> {
    // Check for OAuth mode by looking for Bearer token in headers
    const headers = extra?.requestInfo?.headers as Record<string, string | string[]> | undefined;
    const authHeader = headers?.['authorization'];
    const isOAuthMode = authHeader && (
      typeof authHeader === 'string'
        ? authHeader.startsWith('Bearer ')
        : authHeader[0]?.startsWith('Bearer ')
    );

    if (isOAuthMode) {
      return textResponse(
        `**OAuth Mode Active**\n\n` +
        `You're connected to a single Salesforce org via bearer token. There are no multiple orgs to list.\n\n` +
        `**Important:** The \`usernameOrAlias\` parameter in other tools does NOT matter in OAuth mode - ` +
        `any value you provide will be ignored. The authenticated org from your token is used automatically.\n\n` +
        `Just proceed with your tool calls.`
      );
    }

    try {
      process.chdir(input.directory);
      const orgs = await this.services.getOrgService().getAllowedOrgs();
      return textResponse(`List of configured Salesforce orgs:\n\n${JSON.stringify(orgs, null, 2)}`);
    } catch (error) {
      return textResponse(`Failed to list orgs: ${error instanceof Error ? error.message : 'Unknown error'}`, true);
    }
  }
}
