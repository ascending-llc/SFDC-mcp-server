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
 * Update an existing Salesforce record
 *
 * Parameters:
 * - objectType: Salesforce object API name (e.g., Account, Contact, Lead)
 * - recordId: The 15 or 18-character Salesforce record ID
 * - fields: Field values to update as key-value pairs
 * - usernameOrAlias: Username or alias for the Salesforce org
 * - directory: Directory to run this tool from
 *
 * Returns:
 * - textResponse: Success message or error message
 */

export const updateRecordParamsSchema = z.object({
  objectType: z.string().describe(`Salesforce object API name (e.g., Account, Contact, Lead, Opportunity, Case).

AGENT INSTRUCTIONS:
Common standard objects: Account, Contact, Lead, Opportunity, Case, Task, Event.
Custom objects end with __c (e.g., Invoice__c).
Use the exact API name, not the label.`),
  recordId: z.string().describe(`The 15 or 18-character Salesforce record ID to update.

AGENT INSTRUCTIONS:
Salesforce IDs are either 15 or 18 characters.
If the user references a record by name, first use #run_soql_query to find the record ID.
Example: SELECT Id FROM Account WHERE Name = 'Acme Corp'`),
  fields: z.record(z.unknown()).describe(`Field values to update as key-value pairs.

AGENT INSTRUCTIONS:
Only include fields that need to be updated. Examples:
- {"Name": "New Name"}
- {"Industry": "Finance", "Description": "Updated description"}
- {"StageName": "Closed Won", "Amount": 50000}

Do NOT include the Id field here - it's provided separately in recordId.`),
  usernameOrAlias: usernameOrAliasParam,
  directory: directoryParam,
});

type InputArgs = z.infer<typeof updateRecordParamsSchema>;
type InputArgsShape = typeof updateRecordParamsSchema.shape;
type OutputArgsShape = z.ZodRawShape;

export class UpdateRecordMcpTool extends McpTool<InputArgsShape, OutputArgsShape> {
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
    return 'update_record';
  }

  public getConfig(): McpToolConfig<InputArgsShape, OutputArgsShape> {
    return {
      title: 'Update Record',
      description: `Update an existing record in Salesforce.

AGENT INSTRUCTIONS:
Use this tool to update existing records by ID.
If the user references a record by name instead of ID, first use #run_soql_query to find the record ID.
If the user doesn't specify which org to use, use the #get_username tool first.

EXAMPLE USAGE:
- "Update the account Acme Corp to change the industry to Finance"
- "Change the opportunity stage to Closed Won"
- "Update the contact's email address"
- "Set the lead status to Qualified"`,
      inputSchema: updateRecordParamsSchema.shape,
      outputSchema: undefined,
      annotations: {
        openWorldHint: false,
        readOnlyHint: false,
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
          'The recordId parameter is required. Use #run_soql_query to find the record ID if needed.',
          true
        );
      }

      // Required for org allowlist to work
      process.chdir(input.directory);

      const connection = await this.services.getOrgService().getConnection(input.usernameOrAlias);

      // jsforce update requires Id in the record object
      // Spread fields first, then Id - ensures Id cannot be overridden by fields
      const updateRecord = {
        ...input.fields,
        Id: input.recordId,
      } as { Id: string } & Record<string, unknown>;
      const result = await connection.sobject(input.objectType).update(updateRecord);

      // SaveResult is a discriminated union - must check success === false
      if (result.success === false) {
        return textResponse(
          `Failed to update ${input.objectType} record: ${JSON.stringify(result.errors)}`,
          true
        );
      }

      return textResponse(`Successfully updated ${input.objectType} record with ID: ${result.id}`);
    } catch (error) {
      const e = error as Error;
      // Check for cross-reference error (recordId doesn't match objectType)
      if (e.message?.includes('INVALID_CROSS_REFERENCE_KEY')) {
        return textResponse(
          `Error: The record ID "${input.recordId}" does not appear to be a valid ${input.objectType} record. ` +
          `Salesforce record IDs have prefixes that identify the object type. ` +
          `Please verify the record ID belongs to a ${input.objectType} record.`,
          true
        );
      }
      return textResponse(`Error updating ${input.objectType} record: ${e.name}: ${e.message}`, true);
    }
  }
}
