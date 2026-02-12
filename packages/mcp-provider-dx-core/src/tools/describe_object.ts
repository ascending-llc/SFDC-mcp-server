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

import { z } from 'zod';
import { McpTool, McpToolConfig, ReleaseState, Services, Toolset } from '@salesforce/mcp-provider-api';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { textResponse } from '../shared/utils.js';
import { directoryParam, usernameOrAliasParam } from '../shared/params.js';

/*
 * Describe a Salesforce object
 *
 * Parameters:
 * - objectType: Salesforce object API name (e.g., Account, Contact, Lead)
 * - usernameOrAlias: Username or alias for the Salesforce org
 * - directory: Directory to run this tool from
 *
 * Returns:
 * - textResponse: Object metadata including fields, types, and picklist values
 */

export const describeObjectParamsSchema = z.object({
  objectType: z.string().describe(`Salesforce object API name (e.g., Account, Contact, Lead, Opportunity, Case).

AGENT INSTRUCTIONS:
Common standard objects: Account, Contact, Lead, Opportunity, Case, Task, Event.
Custom objects end with __c (e.g., Invoice__c).
Use the exact API name, not the label.`),
  usernameOrAlias: usernameOrAliasParam,
  directory: directoryParam,
});

type InputArgs = z.infer<typeof describeObjectParamsSchema>;
type InputArgsShape = typeof describeObjectParamsSchema.shape;
type OutputArgsShape = z.ZodRawShape;

export class DescribeObjectMcpTool extends McpTool<InputArgsShape, OutputArgsShape> {
  public constructor(private readonly services: Services) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'describe_object';
  }

  public getConfig(): McpToolConfig<InputArgsShape, OutputArgsShape> {
    return {
      title: 'Describe Object',
      description: `Get metadata about a Salesforce object including field names, types, and picklist values.

AGENT INSTRUCTIONS:
Use this tool BEFORE creating or updating records to discover:
- What fields exist on the object
- Which fields are required vs optional
- Valid picklist values for picklist fields
- Field types (string, number, date, lookup, etc.)

This helps you construct valid create_record or update_record calls.

EXAMPLE USAGE:
- "What fields are on the Lead object?"
- "Show me the Account fields"
- "What are the valid values for Opportunity Stage?"
- "Describe the Case object"`,
      inputSchema: describeObjectParamsSchema.shape,
      outputSchema: undefined,
      annotations: {
        openWorldHint: false,
        readOnlyHint: true,
      },
    };
  }

  public async exec(input: InputArgs): Promise<CallToolResult> {
    try {
      if (!input.usernameOrAlias) {
        return textResponse(
          'The usernameOrAlias parameter is required, if the user did not specify one use the #get_username tool',
          true
        );
      }

      // Required for org allowlist to work
      process.chdir(input.directory);

      const connection = await this.services.getOrgService().getConnection(input.usernameOrAlias);
      const describeResult = await connection.describe(input.objectType);

      // Extract the most useful information for agents
      const summary = {
        name: describeResult.name,
        label: describeResult.label,
        keyPrefix: describeResult.keyPrefix,
        createable: describeResult.createable,
        updateable: describeResult.updateable,
        deletable: describeResult.deletable,
        fields: describeResult.fields.map((field) => ({
          name: field.name,
          label: field.label,
          type: field.type,
          required: !field.nillable && !field.defaultedOnCreate,
          createable: field.createable,
          updateable: field.updateable,
          ...(field.picklistValues && field.picklistValues.length > 0
            ? {
                picklistValues: field.picklistValues
                  .filter((pv: { active: boolean }) => pv.active)
                  .map((pv: { value: string; label: string }) => ({ value: pv.value, label: pv.label })),
              }
            : {}),
          ...(field.referenceTo && field.referenceTo.length > 0
            ? { referenceTo: field.referenceTo }
            : {}),
        })),
      };

      return textResponse(`Object metadata for ${input.objectType}:\n\n${JSON.stringify(summary, null, 2)}`);
    } catch (error) {
      const e = error as Error;
      return textResponse(`Error describing ${input.objectType}: ${e.name}: ${e.message}`, true);
    }
  }
}
