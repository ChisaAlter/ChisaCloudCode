import path from 'node:path';

import type {
  CliApplication,
  CliEnvironment,
  CliFileSystem,
  CliOutput,
  CliPackageMetadata,
  SandboxCommandService,
} from '@/shared/types.js';
import { terminalTextStyles } from '@/shared/utils.js';

type CliServiceDependencies = {
  applicationRoot: string;
  defaultDatabasePath: string;
  homeDirectory: string;
  packageMetadata: CliPackageMetadata;
  environment: CliEnvironment;
  fileSystem: CliFileSystem;
  output: CliOutput;
  sandboxService: SandboxCommandService;
  startServer(): Promise<void>;
  startBrowserUseMcp(): Promise<void>;
};

type ParsedCliArguments = {
  command: string;
  options: {
    serverPort?: string;
    databasePath?: string;
  };
  remainingArguments: string[];
};

function parseCliArguments(argumentsList: string[]): ParsedCliArguments {
  const parsedArguments: ParsedCliArguments = {
    command: 'start',
    options: {},
    remainingArguments: [],
  };

  for (let argumentIndex = 0; argumentIndex < argumentsList.length; argumentIndex += 1) {
    const argument = argumentsList[argumentIndex];
    if (argument === '--port' || argument === '-p') {
      parsedArguments.options.serverPort = argumentsList[++argumentIndex];
    } else if (argument.startsWith('--port=')) {
      parsedArguments.options.serverPort = argument.slice('--port='.length);
    } else if (argument === '--database-path') {
      parsedArguments.options.databasePath = argumentsList[++argumentIndex];
    } else if (argument.startsWith('--database-path=')) {
      parsedArguments.options.databasePath = argument.slice('--database-path='.length);
    } else if (argument === '--help' || argument === '-h') {
      parsedArguments.command = 'help';
    } else if (argument === '--version' || argument === '-v') {
      parsedArguments.command = 'version';
    } else if (!argument.startsWith('-')) {
      parsedArguments.command = argument;
      if (argument === 'sandbox') {
        parsedArguments.remainingArguments = argumentsList.slice(argumentIndex + 1);
        break;
      }
    }
  }

  return parsedArguments;
}

function showStatus(dependencies: CliServiceDependencies): void {
  const { environment, fileSystem, output } = dependencies;
  const databasePath = environment.DATABASE_PATH || dependencies.defaultDatabasePath;
  const databaseExists = fileSystem.pathExists(databasePath);
  const claudeProjectsPath = path.join(dependencies.homeDirectory, '.claude', 'projects');
  const environmentFilePath = path.join(dependencies.applicationRoot, '.env');

  output.log(`\n${terminalTextStyles.bright('ChisaCloudCode UI - Status')}\n`);
  output.log(terminalTextStyles.dim('═'.repeat(60)));
  output.log(`\n${terminalTextStyles.info('[INFO]')} Version: ${terminalTextStyles.bright(dependencies.packageMetadata.version)}`);
  output.log(`\n${terminalTextStyles.info('[INFO]')} Installation Directory:`);
  output.log(`       ${terminalTextStyles.dim(dependencies.applicationRoot)}`);
  output.log(`\n${terminalTextStyles.info('[INFO]')} Database Location:`);
  output.log(`       ${terminalTextStyles.dim(databasePath)}`);
  output.log(`       Status: ${databaseExists
    ? terminalTextStyles.ok('[OK] Exists')
    : terminalTextStyles.warn('[WARN] Not created yet (will be created on first run)')}`);

  if (databaseExists) {
    const databaseStats = fileSystem.getFileStats(databasePath);
    output.log(`       Size: ${terminalTextStyles.dim(`${(databaseStats.size / 1024).toFixed(2)} KB`)}`);
    output.log(`       Modified: ${terminalTextStyles.dim(databaseStats.modifiedAt.toLocaleString())}`);
  }

  output.log(`\n${terminalTextStyles.info('[INFO]')} Configuration:`);
  output.log(`       SERVER_PORT: ${terminalTextStyles.bright(environment.SERVER_PORT || environment.PORT || '3001')} ${terminalTextStyles.dim(environment.SERVER_PORT || environment.PORT ? '' : '(default)')}`);
  output.log(`       DATABASE_PATH: ${terminalTextStyles.dim(environment.DATABASE_PATH || '(using default location)')}`);
  output.log(`       CLAUDE_CLI_PATH: ${terminalTextStyles.dim(environment.CLAUDE_CLI_PATH || 'claude (default)')}`);
  output.log(`       CONTEXT_WINDOW: ${terminalTextStyles.dim(environment.CONTEXT_WINDOW || '160000 (default)')}`);
  output.log(`\n${terminalTextStyles.info('[INFO]')} Claude Projects Folder:`);
  output.log(`       ${terminalTextStyles.dim(claudeProjectsPath)}`);
  output.log(`       Status: ${fileSystem.pathExists(claudeProjectsPath)
    ? terminalTextStyles.ok('[OK] Exists')
    : terminalTextStyles.warn('[WARN] Not found')}`);
  output.log(`\n${terminalTextStyles.info('[INFO]')} Configuration File:`);
  output.log(`       ${terminalTextStyles.dim(environmentFilePath)}`);
  output.log(`       Status: ${fileSystem.pathExists(environmentFilePath)
    ? terminalTextStyles.ok('[OK] Exists')
    : terminalTextStyles.warn('[WARN] Not found (using defaults)')}`);
  output.log(`\n${terminalTextStyles.dim('═'.repeat(60))}`);
  output.log(`\n${terminalTextStyles.tip('[TIP]')} Hints:`);
  output.log(`      ${terminalTextStyles.dim('>')} Use ${terminalTextStyles.bright('chisacloudcode --port 8080')} to run on a custom port`);
  output.log(`      ${terminalTextStyles.dim('>')} Use ${terminalTextStyles.bright('chisacloudcode --database-path /path/to/db')} for custom database`);
  output.log(`      ${terminalTextStyles.dim('>')} Run ${terminalTextStyles.bright('chisacloudcode help')} for all options`);
  output.log(`      ${terminalTextStyles.dim('>')} Access the UI at http://localhost:${environment.SERVER_PORT || environment.PORT || '3001'}\n`);
}

function showHelp(dependencies: CliServiceDependencies): void {
  dependencies.output.log(`
╔═══════════════════════════════════════════════════════════════╗
║              ChisaCloudCode - Command Line Tool               ║
╚═══════════════════════════════════════════════════════════════╝

Usage:
  chisacloudcode [command] [options]

Commands:
  start            Start the ChisaCloudCode server (default)
  sandbox          Manage Docker sandbox environments
  browser-use-mcp  Run Browser MCP stdio server
  status           Show configuration and data locations
  update           Show server update instructions
  help             Show this help information
  version          Show version information

Options:
  -p, --port <port>           Set server port (default: 3001)
  --database-path <path>      Set custom database location
  -h, --help                  Show this help information
  -v, --version               Show version information

Examples:
  $ chisacloudcode                        # Start with defaults
  $ chisacloudcode --port 8080            # Start on port 8080
  $ chisacloudcode sandbox ~/my-project   # Run in a Docker sandbox
  $ chisacloudcode status                 # Show configuration

Environment Variables:
  SERVER_PORT         Set server port (default: 3001)
  PORT                Set server port (default: 3001) (LEGACY)
  DATABASE_PATH       Set custom database location
  CLAUDE_CLI_PATH     Set custom Claude CLI path
  CONTEXT_WINDOW      Set context window size (default: 160000)

`);
}

/**
 * Creates the top-level CLI command service used by the CLI composition root
 * and unit tests. Every filesystem, subprocess, environment, output, and
 * cross-module startup dependency is explicit and required.
 */
export function createCliService(dependencies: CliServiceDependencies): CliApplication {
  return {
    async run(argumentsList) {
      const parsedArguments = parseCliArguments(argumentsList);
      if (parsedArguments.options.serverPort) {
        dependencies.environment.SERVER_PORT = parsedArguments.options.serverPort;
      } else if (!dependencies.environment.SERVER_PORT && dependencies.environment.PORT) {
        dependencies.environment.SERVER_PORT = dependencies.environment.PORT;
      }
      if (parsedArguments.options.databasePath) {
        dependencies.environment.DATABASE_PATH = parsedArguments.options.databasePath;
      }

      switch (parsedArguments.command) {
        case 'start':
          await dependencies.startServer();
          return 0;
        case 'sandbox':
          return dependencies.sandboxService.execute(parsedArguments.remainingArguments);
        case 'browser-use-mcp':
          await dependencies.startBrowserUseMcp();
          return 0;
        case 'status':
        case 'info':
          showStatus(dependencies);
          return 0;
        case 'help':
          showHelp(dependencies);
          return 0;
        case 'version':
          dependencies.output.log(dependencies.packageMetadata.version);
          return 0;
        case 'update':
          dependencies.output.log("ChisaCloudCode updates are managed by the server administrator. Deploy a ChisaCloudCode build to update this instance.");
          return 0;
        default:
          dependencies.output.error(`\n❌ Unknown command: ${parsedArguments.command}`);
          dependencies.output.log('   Run "chisacloudcode help" for usage information.\n');
          return 1;
      }
    },
  };
}
