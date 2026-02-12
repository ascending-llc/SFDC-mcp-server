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
 * Search Salesforce records using SOSL
 *
 * Parameters:
 * - searchTerm: Text to search for
 * - objects: Optional array of objects to search in
 * - usernameOrAlias: Username or alias for the Salesforce org
 * - directory: Directory to run this tool from
 *
 * Returns:
 * - textResponse: Search results from matching records
 */

export const searchRecordsParamsSchema = z.object({
  searchTerm: z.string().describe(`The text to search for across Salesforce records.

AGENT INSTRUCTIONS:
- Minimum 2 characters required
- Searches across name fields and other indexed text fields
- Special characters are automatically escaped for safety`),
  objects: z
    .array(z.string())
    .optional()
    .describe(`Optional: Specific objects to search in (e.g., ["Account", "Contact", "Lead"]).

AGENT INSTRUCTIONS:
If not specified, searches across all searchable objects.
Limit to specific objects when the user mentions them, e.g., "find John in Contacts"`),
  usernameOrAlias: usernameOrAliasParam,
  directory: directoryParam,
});

type InputArgs = z.infer<typeof searchRecordsParamsSchema>;
type InputArgsShape = typeof searchRecordsParamsSchema.shape;
type OutputArgsShape = z.ZodRawShape;

export class SearchRecordsMcpTool extends McpTool<InputArgsShape, OutputArgsShape> {
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
    return 'search_records';
  }

  public getConfig(): McpToolConfig<InputArgsShape, OutputArgsShape> {
    return {
      title: 'Search Records',
      description: `Search for records across multiple Salesforce objects using SOSL (Salesforce Object Search Language).

AGENT INSTRUCTIONS:
Use this tool when users want to find records by name or text across multiple objects.
This is more natural than SOQL for searches like "find John" or "search for Acme".

For precise queries on a single object with specific conditions, use #run_soql_query instead.

EXAMPLE USAGE:
- "Find John" → searches all objects for "John"
- "Search for Acme in Accounts and Leads" → searches specific objects
- "Look up customer 12345" → searches for that text
- "Find all records mentioning cloud" → text search`,
      inputSchema: searchRecordsParamsSchema.shape,
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

      if (!input.searchTerm || input.searchTerm.length < 2) {
        return textResponse('Search term must be at least 2 characters long', true);
      }

      // Required for org allowlist to work
      process.chdir(input.directory);

      const connection = await this.services.getOrgService().getConnection(input.usernameOrAlias);

      // Build SOSL query
      // Escape special SOSL characters in search term
      const escapedSearchTerm = input.searchTerm.replace(/[?&|!{}\[\]()^~*:\\"-]/g, '\\$&');

      let soslQuery: string;
      if (input.objects && input.objects.length > 0) {
        // Search specific objects with common fields
        const objectClauses = input.objects
          .map((obj) => `${obj}(Id, Name)`)
          .join(', ');
        soslQuery = `FIND {${escapedSearchTerm}} IN ALL FIELDS RETURNING ${objectClauses} LIMIT 50`;
      } else {
        // Search common objects
        soslQuery = `FIND {${escapedSearchTerm}} IN ALL FIELDS RETURNING Account(Id, Name), Contact(Id, Name, Email), Lead(Id, Name, Company), Opportunity(Id, Name) LIMIT 50`;
      }

      const searchResult = await connection.search(soslQuery);

      // Format results
      const results = searchResult.searchRecords.map((record) => ({
        type: record.attributes?.type,
        id: record.Id,
        ...record,
      }));

      if (results.length === 0) {
        return textResponse(`No records found matching "${input.searchTerm}"`);
      }

      return textResponse(
        `Found ${results.length} record(s) matching "${input.searchTerm}":\n\n${JSON.stringify(results, null, 2)}`
      );
    } catch (error) {
      const e = error as Error;
      return textResponse(`Error searching records: ${e.name}: ${e.message}`, true);
    }
  }
}
