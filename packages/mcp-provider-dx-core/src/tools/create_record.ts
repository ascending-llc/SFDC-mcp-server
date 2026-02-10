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
 * Create a new Salesforce record
 *
 * Parameters:
 * - objectType: Salesforce object API name (e.g., Account, Contact, Lead)
 * - fields: Field values as key-value pairs
 * - usernameOrAlias: Username or alias for the Salesforce org
 * - directory: Directory to run this tool from
 *
 * Returns:
 * - textResponse: Success message with created record ID or error message
 */

export const createRecordParamsSchema = z.object({
  objectType: z.string().describe(`Salesforce object API name (e.g., Account, Contact, Lead, Opportunity, Case).

AGENT INSTRUCTIONS:
Common standard objects: Account, Contact, Lead, Opportunity, Case, Task, Event.
Custom objects end with __c (e.g., Invoice__c).
Use the exact API name, not the label.`),
  fields: z.record(z.unknown()).describe(`Field values as key-value pairs.

AGENT INSTRUCTIONS:
Provide field API names and values. Examples:
- Account: {"Name": "Acme Corp", "Industry": "Technology"}
- Contact: {"FirstName": "John", "LastName": "Doe", "Email": "john@example.com"}
- Lead: {"FirstName": "Jane", "LastName": "Smith", "Company": "Tech Inc"}
- Opportunity: {"Name": "Big Deal", "StageName": "Prospecting", "CloseDate": "2025-12-31"}

Required fields vary by object. If creation fails due to missing required fields, the error will indicate which fields are needed.`),
  usernameOrAlias: usernameOrAliasParam,
  directory: directoryParam,
});

type InputArgs = z.infer<typeof createRecordParamsSchema>;
type InputArgsShape = typeof createRecordParamsSchema.shape;
type OutputArgsShape = z.ZodRawShape;

export class CreateRecordMcpTool extends McpTool<InputArgsShape, OutputArgsShape> {
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
    return 'create_record';
  }

  public getConfig(): McpToolConfig<InputArgsShape, OutputArgsShape> {
    return {
      title: 'Create Record',
      description: `Create a new record in Salesforce.

AGENT INSTRUCTIONS:
Use this tool to create new records (Accounts, Contacts, Leads, Opportunities, Cases, etc.).
The user should specify the object type and field values.
If the user doesn't specify which org to use, use the #get_username tool first.

EXAMPLE USAGE:
- "Create a new account called Acme Corp"
- "Add a contact named John Doe with email john@example.com"
- "Create a lead for Jane Smith at Tech Inc"
- "Add a new opportunity called Big Deal in the Prospecting stage"`,
      inputSchema: createRecordParamsSchema.shape,
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

      // Required for org allowlist to work
      process.chdir(input.directory);

      const connection = await this.services.getOrgService().getConnection(input.usernameOrAlias);
      const result = await connection.sobject(input.objectType).create(input.fields as Record<string, unknown>);

      // SaveResult is a discriminated union - must check success === false
      if (result.success === false) {
        return textResponse(
          `Failed to create ${input.objectType} record: ${JSON.stringify(result.errors)}`,
          true
        );
      }

      return textResponse(`Successfully created ${input.objectType} record with ID: ${result.id}`);
    } catch (error) {
      const e = error as Error;
      return textResponse(`Error creating ${input.objectType} record: ${e.name}: ${e.message}`, true);
    }
  }
}
