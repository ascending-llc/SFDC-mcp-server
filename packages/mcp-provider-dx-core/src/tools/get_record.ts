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
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { textResponse } from '../shared/utils.js';
import { directoryParam, usernameOrAliasParam } from '../shared/params.js';

/*
 * Get a single Salesforce record by ID
 *
 * Parameters:
 * - objectType: Salesforce object API name (e.g., Account, Contact, Lead)
 * - recordId: The 15 or 18-character Salesforce record ID
 * - fields: Optional array of specific fields to retrieve
 * - usernameOrAlias: Username or alias for the Salesforce org
 * - directory: Directory to run this tool from
 *
 * Returns:
 * - textResponse: The record data
 */

export const getRecordParamsSchema = z.object({
  objectType: z.string().describe(`Salesforce object API name (e.g., Account, Contact, Lead, Opportunity, Case).

AGENT INSTRUCTIONS:
Common standard objects: Account, Contact, Lead, Opportunity, Case, Task, Event.
Custom objects end with __c (e.g., Invoice__c).
Use the exact API name, not the label.`),
  recordId: z.string().describe(`The 15 or 18-character Salesforce record ID to retrieve.

AGENT INSTRUCTIONS:
Salesforce IDs are either 15 or 18 characters.
The ID prefix indicates the object type (e.g., 001 = Account, 003 = Contact, 00Q = Lead).`),
  fields: z
    .array(z.string())
    .optional()
    .describe(`Optional: Specific fields to retrieve (e.g., ["Name", "Industry", "Phone"]).

AGENT INSTRUCTIONS:
If not specified, retrieves all accessible fields.
Specify fields to reduce response size or get specific data.
Use #describe_object to discover available field names.`),
  usernameOrAlias: usernameOrAliasParam,
  directory: directoryParam,
});

type InputArgs = z.infer<typeof getRecordParamsSchema>;
type InputArgsShape = typeof getRecordParamsSchema.shape;
type OutputArgsShape = z.ZodRawShape;

export class GetRecordMcpTool extends McpTool<InputArgsShape, OutputArgsShape> {
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
    return 'get_record';
  }

  public getConfig(): McpToolConfig<InputArgsShape, OutputArgsShape> {
    return {
      title: 'Get Record',
      description: `Retrieve a single Salesforce record by its ID.

AGENT INSTRUCTIONS:
Use this tool when you have a record ID and want to see its details.
Simpler than writing a SOQL query for single record lookups.

For querying multiple records or complex conditions, use #run_soql_query instead.

EXAMPLE USAGE:
- "Get the account 001XXXXXXXXXXXX"
- "Show me the details for contact 003XXXXXXXXXXXX"
- "Retrieve the lead record"
- "What are the details of this opportunity?"`,
      inputSchema: getRecordParamsSchema.shape,
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

      if (!input.recordId) {
        return textResponse(
          'The recordId parameter is required. Use #search_records or #run_soql_query to find the record ID if needed.',
          true
        );
      }

      // Required for org allowlist to work
      process.chdir(input.directory);

      const connection = await this.services.getOrgService().getConnection(input.usernameOrAlias);

      // Build retrieve options
      const options = input.fields && input.fields.length > 0 ? { fields: input.fields } : undefined;

      const record = await connection.sobject(input.objectType).retrieve(input.recordId, options);

      if (!record || (typeof record === 'object' && Object.keys(record).length === 0)) {
        return textResponse(`No ${input.objectType} record found with ID: ${input.recordId}`, true);
      }

      return textResponse(
        `${input.objectType} record (${input.recordId}):\n\n${JSON.stringify(record, null, 2)}`
      );
    } catch (error) {
      const e = error as Error;
      // Handle common errors
      if (e.message.includes('NOT_FOUND') || e.message.includes('INVALID_CROSS_REFERENCE_KEY')) {
        return textResponse(`No ${input.objectType} record found with ID: ${input.recordId}`, true);
      }
      return textResponse(`Error retrieving ${input.objectType} record: ${e.name}: ${e.message}`, true);
    }
  }
}
