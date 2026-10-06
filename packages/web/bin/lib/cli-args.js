import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { brandProductText } from '../../brand.generated.js';

const DEFAULT_PORT = 3000;
const DEFAULT_TAIL_LINES = 200;

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function findClosestMatch(input, candidates, maxDistance = 3) {
  if (typeof input !== 'string' || input.length === 0 || !Array.isArray(candidates)) {
    return null;
  }
  const normalized = input.toLowerCase();
  let bestCandidate = null;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const distance = levenshteinDistance(normalized, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      bestCandidate = candidate;
    }
  }
  return bestDistance <= maxDistance ? bestCandidate : null;
}

function splitOptionToken(arg) {
  if (!arg.startsWith('-')) return null;
  if (arg.startsWith('--')) {
    const eqIndex = arg.indexOf('=');
    return {
      name: eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2),
      inlineValue: eqIndex >= 0 ? arg.slice(eqIndex + 1) : undefined,
      long: true,
    };
  }
  return {
    name: arg.slice(1),
    inlineValue: undefined,
    long: false,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const options = {
    port: DEFAULT_PORT,
    host: undefined,
    uiPassword: process.env.OPENCHAMBER_UI_PASSWORD || undefined,
    json: false,
    all: false,
    follow: true,
    lines: DEFAULT_TAIL_LINES,
    limit: undefined,
    name: undefined,
    title: undefined,
    hostname: undefined,
    server: undefined,
    qr: false,
    plain: false,
    quiet: false,
    explicitPort: false,
    explicitUiPassword: false,
    envSnapshot: true,
    foreground: false,
    lan: false,
    apiOnly: false,
    project: undefined,
    task: undefined,
    session: undefined,
    message: undefined,
    prompt: undefined,
    model: undefined,
    daily: undefined,
    weekly: undefined,
    once: undefined,
    time: undefined,
    cron: undefined,
    timezone: undefined,
    agent: undefined,
    variant: undefined,
    disabled: false,
    goal: false,
    goalTokenBudget: undefined,
    directory: undefined,
    role: undefined,
    last: false,
    wait: false,
    timeout: undefined,
    lastAssistant: false,
    withStatus: false,
  };

  const removedFlagErrors = [];
  const positional = [];
  let helpRequested = false;
  let versionRequested = false;

  const consumeValue = (index, inlineValue) => {
    if (typeof inlineValue === 'string' && inlineValue.length > 0) {
      return { value: inlineValue, nextIndex: index };
    }
    const candidate = args[index + 1];
    if (typeof candidate === 'string' && !candidate.startsWith('-')) {
      return { value: candidate, nextIndex: index + 1 };
    }
    return { value: undefined, nextIndex: index };
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const parsedToken = splitOptionToken(arg);
    if (!parsedToken) {
      positional.push(arg);
      continue;
    }

    const { name, inlineValue, long } = parsedToken;
    switch (name) {
      case 'port':
      case 'p': {
        const { value: consumedValue, nextIndex: consumedIndex } = consumeValue(i, inlineValue);
        let value = consumedValue;
        let nextIndex = consumedIndex;

        // Support explicit negative numeric values like `-p -1` so we can report
        // a clear range validation error instead of "Unknown option".
        if (value === undefined && typeof inlineValue !== 'string') {
          const candidate = args[i + 1];
          if (typeof candidate === 'string' && /^-\d+$/.test(candidate)) {
            value = candidate;
            nextIndex = i + 1;
          }
        }

        i = nextIndex;

        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new TunnelCliError('Missing value for --port.', EXIT_CODE.USAGE_ERROR);
        }

        if (!/^-?\d+$/.test(value.trim())) {
          throw new TunnelCliError(`Invalid port value: ${value}`, EXIT_CODE.USAGE_ERROR);
        }

        const parsed = parseInt(value, 10);
        if (parsed < 1 || parsed > 65535) {
          throw new TunnelCliError(`Invalid port value: ${parsed}`, EXIT_CODE.USAGE_ERROR);
        }

        options.port = parsed;
        options.explicitPort = true;
        break;
      }
      case 'host': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new TunnelCliError('Missing value for --host.', EXIT_CODE.USAGE_ERROR);
        }
        options.host = value.trim();
        break;
      }
      case 'lan':
        options.lan = true;
        break;
      case 'ui-password': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.uiPassword = typeof value === 'string' ? value : '';
        options.explicitUiPassword = true;
        break;
      }
      case 'name': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.name = typeof value === 'string' ? value : options.name;
        break;
      }
      case 'title': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.title = typeof value === 'string' ? value : options.title;
        break;
      }
      case 'worktree': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.worktree = typeof value === 'string' ? value : options.worktree;
        break;
      }
      case 'branch': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.branch = typeof value === 'string' ? value : options.branch;
        break;
      }
      case 'start-ref':
      case 'base': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.startRef = typeof value === 'string' ? value : options.startRef;
        break;
      }
      case 'upstream':
        options.setUpstream = true;
        break;
      case 'no-upstream':
        options.setUpstream = false;
        break;
      case 'project': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.project = typeof value === 'string' ? value : options.project;
        break;
      }
      case 'dir':
      case 'directory': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.directory = typeof value === 'string' ? value : options.directory;
        break;
      }
      case 'task': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.task = typeof value === 'string' ? value : options.task;
        break;
      }
      case 'session': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.session = typeof value === 'string' ? value : options.session;
        break;
      }
      case 'message': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.message = typeof value === 'string' ? value : options.message;
        break;
      }
      case 'prompt': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.prompt = typeof value === 'string' ? value : options.prompt;
        break;
      }
      case 'model': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.model = typeof value === 'string' ? value : options.model;
        break;
      }
      case 'daily': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.daily = typeof value === 'string' ? value : options.daily;
        break;
      }
      case 'weekly': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.weekly = typeof value === 'string' ? value : options.weekly;
        break;
      }
      case 'once': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.once = typeof value === 'string' ? value : options.once;
        break;
      }
      case 'time': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.time = typeof value === 'string' ? value : options.time;
        break;
      }
      case 'cron': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.cron = typeof value === 'string' ? value : options.cron;
        break;
      }
      case 'timezone': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.timezone = typeof value === 'string' ? value : options.timezone;
        break;
      }
      case 'agent': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.agent = typeof value === 'string' ? value : options.agent;
        break;
      }
      case 'variant': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.variant = typeof value === 'string' ? value : options.variant;
        break;
      }
      case 'disabled':
        options.disabled = true;
        break;
      case 'goal':
        options.goal = true;
        break;
      case 'goal-token-budget': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.goalTokenBudget = value;
        break;
      }
      case 'hostname': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.hostname = typeof value === 'string' ? value : options.hostname;
        break;
      }
      case 'server':
      case 'server-url': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new TunnelCliError('Missing value for --server.', EXIT_CODE.USAGE_ERROR);
        }
        options.server = value.trim();
        break;
      }
      case 'json':
        options.json = true;
        break;
      case 'all':
        options.all = true;
        break;
      case 'last':
        options.last = true;
        break;
      case 'last-assistant':
        options.lastAssistant = true;
        break;
      case 'wait':
        options.wait = true;
        break;
      case 'timeout': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.timeout = typeof value === 'string' ? value : options.timeout;
        break;
      }
      case 'with-status':
        options.withStatus = true;
        break;
      case 'role': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        options.role = typeof value === 'string' ? value : options.role;
        break;
      }
      case 'no-follow':
        options.follow = false;
        break;
      case 'no-env-snapshot':
        options.envSnapshot = false;
        break;
      case 'lines': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        const parsed = parseInt(value ?? '', 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          options.lines = parsed;
        }
        break;
      }
      case 'limit': {
        const { value, nextIndex } = consumeValue(i, inlineValue);
        i = nextIndex;
        const parsed = parseInt(value ?? '', 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new TunnelCliError('Invalid limit value. Provide a positive integer.', EXIT_CODE.USAGE_ERROR);
        }
        options.limit = parsed;
        break;
      }
      case 'qr':
        options.qr = true;
        break;
      case 'no-qr':
        options.qr = false;
        break;
      case 'plain':
        options.plain = true;
        break;
      case 'quiet':
      case 'q':
        options.quiet = true;
        break;
      case 'help':
      case 'h':
        helpRequested = true;
        break;
      case 'version':
      case 'v':
        versionRequested = true;
        break;
      case 'foreground':
      case 'no-daemon':
        options.foreground = true;
        break;
      case 'api-only':
        options.apiOnly = true;
        break;
      case 'daemon':
      case 'd':
        // Legacy no-op: daemon mode is already the default, but older clients
        // may still pass this when starting a remote server.
        break;
      default:
        if (!long && name.length === 1) {
          removedFlagErrors.push(`Unknown option: -${name}`);
        } else {
          removedFlagErrors.push(`Unknown option: --${name}`);
        }
        break;
    }
  }

  const command = positional[0] || 'serve';
  const startupAction = command === 'startup' ? (positional[1] || 'status') : null;
  const scheduleAction = command === 'schedule' ? (positional[1] || 'help') : null;
  const sessionAction = command === 'session' ? (positional[1] || 'help') : null;
  const controlAction = command === 'control' ? (positional[1] || 'help') : null;

  if (options.lan && typeof options.host !== 'string') {
    options.host = '0.0.0.0';
  }

  if (typeof options.hostname === 'string' && typeof options.host !== 'string') {
    options.host = options.hostname;
  }

  return {
    command,
    startupAction,
    scheduleAction,
    sessionAction,
    controlAction,
    options,
    removedFlagErrors,
    helpRequested,
    versionRequested,
  };
}

function showHelp() {
  console.log(brandProductText(`
 OpenChamber - AI coding workspace

USAGE:
  openchamber [COMMAND] [OPTIONS]

COMMANDS:
  serve          Start the web server (daemon default)
  stop           Stop running instance(s)
  restart        Stop and start the server
  status         Show server status
  schedule       Manage scheduled tasks
  session        Create, inspect, and read OpenChamber sessions
  models         Show default and favorite models
  projects       Show configured projects and IDs
  control        Show OpenChamber control-plane commands
  startup        Manage launch at system startup
  logs           Tail OpenChamber logs
  connect-url    Generate URL/QR for connecting another client

OPTIONS:
  -p, --port              Web server port (default: ${DEFAULT_PORT})
  --host                  Bind address (default: 127.0.0.1)
  --hostname              Alias for --host
  --lan                   Bind to 0.0.0.0 for LAN access
  --server <url>          Public/server URL for connect-url links
  --ui-password [password] Protect browser UI with a password (generates one when omitted)
  --api-only              Start API routes only, without serving browser UI assets
  --foreground            Run server in foreground (use with systemd/process managers)
  --no-daemon             Alias for --foreground
  -h, --help              Show help
  -v, --version           Show version

ENVIRONMENT:
  OPENCHAMBER_HOST             Bind address (e.g. 0.0.0.0 for all interfaces)
  OPENCHAMBER_UI_PASSWORD      Alternative to --ui-password flag
  OPENCHAMBER_API_ONLY         Set to true/1 to start API routes only
  OPENCHAMBER_DATA_DIR         Override OpenChamber data directory
  OPENCODE_HOST                 External engine server base URL, e.g. http://hostname:4096
  OPENCODE_PORT                 Port of external engine server to connect to
  OPENCODE_SKIP_START           Skip starting the managed engine; use an external server
  OPENCHAMBER_OPENCODE_HOSTNAME Bind hostname for managed engine server (default: 127.0.0.1)

EXAMPLES:
  openchamber                    # Start in daemon mode on default port 3000 (or free port)
  openchamber --port 8080        # Start on port 8080 (daemon)
  openchamber --lan --port 3002  # Start on LAN at 0.0.0.0:3002
  openchamber serve --foreground # Start in foreground (for systemd Type=simple)
  openchamber connect-url --port 3000 --qr
  openchamber connect-url --server https://openchamber.example.com
  openchamber control           # Show control-plane commands for agents/scripts
  openchamber startup enable     # Start OpenChamber at user login
  openchamber logs               # Follow logs for latest running instance
`));
}

function showControlHelp() {
  console.log(brandProductText(`
 OpenChamber Control Commands

USAGE:
  openchamber <COMMAND> [OPTIONS]

COMMANDS:
  status                         Show running OpenChamber runtimes
  session                        Create, inspect, and read sessions
  models                         Show default and favorite models
  projects                       Show configured projects and IDs
  schedule                       Manage scheduled tasks
  logs                           Tail logs for CLI-managed runtimes

DETAILED HELP:
  openchamber session --help     Show session creation, status, and message options
  openchamber models --help      Show model defaults and favorites help
  openchamber projects --help    Show project list help
  openchamber schedule --help    Show scheduled task actions and schedule options
  openchamber status --help      Show runtime status options

COMMON OPTIONS:
  --json                         Output machine-readable JSON
  -q, --quiet                    Print minimal output
  -p, --port <port>              Target a specific OpenChamber runtime
  --ui-password <password>       Authenticate to a password-protected runtime

EXAMPLES:
  openchamber status
  openchamber models
  openchamber projects
  openchamber session --help
  openchamber schedule --help
`));
}

function showStartupHelp() {
  console.log(brandProductText(`
 OpenChamber Startup Commands

USAGE:
  openchamber startup <SUBCOMMAND> [OPTIONS]

SUBCOMMANDS:
  status      Show startup integration status
  enable      Install and start native user startup integration
  disable     Stop and remove native user startup integration

OPTIONS:
  -p, --port              Web server port used by startup service
  --host                  Bind address used by startup service
  --ui-password           Protect browser UI with single password
  --api-only              Start API routes only, without serving browser UI assets
  --no-env-snapshot       Do not save current environment for startup service
  --json                  Output machine-readable JSON
  -q, --quiet             Suppress non-essential output

EXAMPLES:
  openchamber startup enable
  openchamber startup enable --port 3000
  openchamber startup enable --port 3000 --api-only --host 0.0.0.0
  openchamber startup status --json
`));
}

function showConnectUrlHelp() {
  console.log(brandProductText(`
 OpenChamber Connect URL

USAGE:
  openchamber connect-url [OPTIONS]

DESCRIPTION:
  Generate an openchamber:// connection link for adding this server to another
  OpenChamber app. If no server is running on the selected port, it starts one.

OPTIONS:
  -p, --port <port>       Server port to use or start (default: ${DEFAULT_PORT})
  --host <address>        Bind address when starting the server
  --hostname <address>    Alias for --host
  --lan                   Bind to 0.0.0.0 for LAN access when starting
  --server <url>          Public URL saved into the connection link
  --server-url <url>      Alias for --server
  --name <label>          Label saved with the remote client token
  --ui-password <value>   Protect browser access when UI routes are enabled
  --api-only              Start in headless/API-only mode when starting
  --qr                    Print a QR code for the connection link
  --json                  Output machine-readable JSON
  -q, --quiet             Print only the connection link
  -h, --help              Show this help

EXAMPLES:
  openchamber connect-url --port 3000 --qr
  openchamber connect-url --port 3000 --api-only --lan --server http://workstation.local:3000 --qr
  openchamber connect-url --server https://openchamber.example.com --name Workstation
`));
}

export {
  DEFAULT_PORT,
  parseArgs,
  showHelp,
  showControlHelp,
  showStartupHelp,
  showConnectUrlHelp,
  findClosestMatch,
};
