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

/* eslint-disable no-console */

import { TOOLSETS } from '@salesforce/mcp-provider-api';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Command, Flags, ux } from '@oclif/core';
import Cache from './utils/cache.js';
import { Telemetry } from './telemetry.js';
import { SfMcpServer } from './sf-mcp-server.js';
import { registerToolsets } from './utils/registry-utils.js';
import { Services } from './services.js';
import { startHttpServer } from './http-server.js';

/**
 * Sanitizes an array of org usernames by replacing specific orgs with a placeholder.
 * Special values (DEFAULT_TARGET_ORG, DEFAULT_TARGET_DEV_HUB, ALLOW_ALL_ORGS) are preserved.
 *
 * @param {string[]} input - Array of org identifiers to sanitize
 * @returns {string} Comma-separated string of sanitized org identifiers
 */
function sanitizeOrgInput(input: string[]): string {
  return input
    .map((org) => {
      if (org === 'DEFAULT_TARGET_ORG' || org === 'DEFAULT_TARGET_DEV_HUB' || org === 'ALLOW_ALL_ORGS') {
        return org;
      }

      return 'SANITIZED_ORG';
    })
    .join(', ');
}

export default class McpServerCommand extends Command {
  public static summary = 'Start the Salesforce MCP server';
  public static description = `This command starts the Model Context Protocol (MCP) server for Salesforce, allowing access to various tools and orgs.

See: https://github.com/salesforcecli/mcp
  `;

  public static flags = {
    orgs: Flags.string({
      char: 'o',
      summary: 'Org usernames to allow access to',
      description: `If you need to pass more than one username/alias, separate them with commas.

You can also use special values to control access to orgs:
- DEFAULT_TARGET_ORG: Allow access to default orgs (global and local)
- DEFAULT_TARGET_DEV_HUB: Allow access to default dev hubs (global and local)
- ALLOW_ALL_ORGS: Allow access to all authenticated orgs (use with caution)`,
      required: true,
      multiple: true,
      delimiter: ',',
      parse: async (input: string) => {
        if (input === 'ALLOW_ALL_ORGS') {
          ux.warn('ALLOW_ALL_ORGS is set. This allows access to all authenticated orgs. Use with caution.');
        }

        if (
          input === 'DEFAULT_TARGET_ORG' ||
          input === 'DEFAULT_TARGET_DEV_HUB' ||
          input.includes('@') ||
          !input.startsWith('-')
        ) {
          return Promise.resolve(input);
        }

        ux.error(
          `Invalid org input: "${input}". Please provide a valid org username or alias, or use one of the special values: DEFAULT_TARGET_ORG, DEFAULT_TARGET_DEV_HUB, ALLOW_ALL_ORGS.`
        );
      },
    }),
    toolsets: Flags.option({
      options: ['all', ...TOOLSETS] as const,
      summary: 'Toolset(s) to enable. Set to "all" to enable every toolset',
      multiple: true,
      delimiter: ',',
      exclusive: ['dynamic-tools'],
    })(),
    // It would be nice if we could get these as an Flags.option
    // Since the tools need `services` passed in I am not sure we
    // can get the list of tools this early. We could build a json
    // manifest (pre-commit) that could be read from for tool names
    tools: Flags.string({
      summary: 'Tool(s) to enable',
      multiple: true,
      delimiter: ',',
      exclusive: ['dynamic-tools'],
    }),
    version: Flags.version(),
    'no-telemetry': Flags.boolean({
      summary: 'Disable telemetry',
    }),
    debug: Flags.boolean({
      summary: 'Enable debug logging',
    }),
    'dynamic-tools': Flags.boolean({
      summary: 'Enable dynamic toolsets',
      char: 'd',
      exclusive: ['toolsets'],
    }),
    'allow-non-ga-tools': Flags.boolean({
      summary: 'Enable the ability to register tools that are not yet generally available (GA)',
    }),
    transport: Flags.option({
      options: ['stdio', 'http'] as const,
      summary: 'Transport mode for the MCP server',
      description: `Choose how the server communicates:
- stdio: Standard input/output (default, for Claude Desktop)
- http: HTTP server mode (for LibreChat/Jarvis integration)`,
      default: 'stdio',
    })(),
    'http-host': Flags.string({
      summary: 'HTTP server host (only used with --transport http)',
      description: 'Host address for HTTP server. Defaults to 0.0.0.0 (all interfaces)',
      default: '0.0.0.0',
      dependsOn: ['transport'],
    }),
    'http-port': Flags.integer({
      summary: 'HTTP server port (only used with --transport http)',
      description: 'Port for HTTP server. Can also be set via SF_MCP_HTTP_PORT environment variable',
      default: 3336,
      dependsOn: ['transport'],
    }),
  };

  public static examples = [
    {
      description: 'Start the server with all toolsets enabled and access only to the default org in the project',
      command: '<%= config.bin %> --toolsets all --orgs DEFAULT_TARGET_ORG',
    },
    {
      description: 'Allow access to the default target org and "my-alias" with only the "data" toolset',
      command: '<%= config.bin %> --orgs DEFAULT_TARGET_DEV_HUB,my-alias --toolsets data',
    },
    {
      description: 'Allow access to 3 specific orgs and enable all toolsets',
      command: '<%= config.bin %> --toolsets all --orgs test-org@example.com,my-dev-hub,my-alias',
    },
    {
      description: 'Start the server with the "data" toolset and also the "create_scratch_org" tool',
      command: '<%= config.bin %> --orgs DEFAULT_TARGET_ORG --toolsets data --tools create_scratch_org',
    },
    {
      description: 'Allow tools that are not generally available (NON-GA) to be registered with the server',
      command: '<%= config.bin %> --toolsets all --orgs DEFAULT_TARGET_ORG --allow-non-ga-tools',
    },
    {
      description: 'Start the server in HTTP mode for LibreChat/Jarvis integration',
      command: '<%= config.bin %> --transport http --toolsets all --orgs DEFAULT_TARGET_ORG',
    },
    {
      description: 'Start HTTP server on custom host and port',
      command: '<%= config.bin %> --transport http --http-host 127.0.0.1 --http-port 8080 --toolsets all --orgs DEFAULT_TARGET_ORG',
    },
  ];

  private telemetry?: Telemetry;

  public async run(): Promise<void> {
    const { flags } = await this.parse(McpServerCommand);

    if (!flags['no-telemetry']) {
      this.telemetry = new Telemetry(this.config, {
        toolsets: (flags.toolsets ?? []).join(', '),
        orgs: sanitizeOrgInput(flags.orgs),
      });

      await this.telemetry.start();

      process.stdin.on('close', () => {
        this.telemetry?.sendEvent('SERVER_STOPPED_SUCCESS');
        this.telemetry?.stop();
      });
      
      // Handle SIGTERM as a fallback to ensure telemetry is sent
      // https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle#stdio
      process.stdin.on('SIGTERM', () => {
        this.telemetry?.sendEvent('SERVER_STOPPED_SUCCESS');
        this.telemetry?.stop();
      });
    }

    await Cache.safeSet('allowedOrgs', new Set(flags.orgs));
    this.logToStderr(`Allowed orgs:\n${flags.orgs.map((org) => `- ${org}`).join('\n')}`);
    const server = new SfMcpServer(
      {
        name: 'sf-mcp-server',
        version: this.config.version,
        capabilities: {
          resources: {},
          tools: {},
        },
      },
      {
        telemetry: this.telemetry,
      }
    );

    const services = new Services({
      telemetry: this.telemetry,
      dataDir: this.config.dataDir,
      // Startup flags that could be useful to reference inside of a MCP tool
      startupFlags: {
        // !! Never pass the 'orgs' flag here. Use 'getOrgService()'.
        'allow-non-ga-tools': flags['allow-non-ga-tools'],
        debug: flags.debug,
      },
    });

    await registerToolsets(
      flags.toolsets ?? [],
      flags.tools ?? [],
      flags['dynamic-tools'] ?? false,
      flags['allow-non-ga-tools'] ?? false,
      server,
      services
    );

    // Select transport mode
    if (flags.transport === 'http') {
      const httpHost = flags['http-host'] ?? process.env.SF_MCP_HTTP_HOST ?? '0.0.0.0';
      const httpPort = flags['http-port'] ?? parseInt(process.env.SF_MCP_HTTP_PORT ?? '3336', 10);

      // Start HTTP server with StreamableHTTP transport
      await startHttpServer({
        host: httpHost,
        port: httpPort,
        config: {
          name: 'sf-mcp-server',
          version: this.config.version,
          capabilities: {
            resources: {},
            tools: {},
          }
        },
        telemetry: this.telemetry,
        toolsets: flags.toolsets ?? [],
        tools: flags.tools ?? [],
        dynamicTools: flags['dynamic-tools'] ?? false,
        allowNonGaTools: flags['allow-non-ga-tools'] ?? false,
        allowedOrgs: new Set(flags.orgs),
        services
      });

      // Keep process alive for HTTP mode
      await new Promise(() => {
        // This promise never resolves, keeping the server running
      });
    } else {
      const transport = new StdioServerTransport();
      await server.connect(transport);

      console.error(`✅ Salesforce MCP Server v${this.config.version} running on stdio`);
    }
  }

  protected async catch(error: Error): Promise<void> {
    if (!this.telemetry && !process.argv.includes('--no-telemetry')) {
      this.telemetry = new Telemetry(this.config);
      await this.telemetry.start();
    }

    // Track startup failures such as invalid flags, missing dependencies, or initialization errors
    this.telemetry?.sendEvent('START_ERROR', {
      error: error.message,
      stack: error.stack,
    });

    await super.catch(error);
  }
}
