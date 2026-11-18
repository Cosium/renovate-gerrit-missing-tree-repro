// Reproduces "remote unpack failed: error Missing tree" on a Renovate push to
// Gerrit, from a clean Gerrit.
//
// Usage:
//   node scripts/run.ts released                 # renovate/renovate Docker image
//   node scripts/run.ts source <renovate-clone>  # Renovate run from source (pnpm start)
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

type Mode =
  | { readonly kind: 'released' }
  | { readonly kind: 'source'; readonly renovateClone: string };

interface Change {
  readonly _number: number;
  readonly subject: string;
}

interface LogEntry {
  readonly msg: string;
  readonly branch?: string;
  readonly err?: { readonly message?: string };
}

const reproDir = dirname(import.meta.dirname);
const gerritPort = process.env.GERRIT_PORT ?? '8080';
const gerrit = `http://localhost:${gerritPort}`;
const adminAuthorization = `Basic ${Buffer.from('admin:secret').toString('base64')}`;
const project = 'missing-tree-demo';
const projectUrl = `http://admin:secret@localhost:${gerritPort}/a/${project}`;

const parseMode = (args: readonly string[]): Mode => {
  const [kind, renovateClone] = args;
  if (kind === 'released') {
    return { kind };
  }
  if (kind === 'source' && renovateClone) {
    return { kind, renovateClone: resolve(renovateClone) };
  }
  console.error('usage: node scripts/run.ts released | source <renovate-clone>');
  process.exit(2);
};

const log = (message: string): void => {
  console.log(`\n==> ${message}`);
};

// The caller's own RENOVATE_* variables would otherwise change the runs.
const buildEnvironment = (
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('RENOVATE_'),
    ),
  ),
  ...overrides,
});

const run = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): string =>
  execFileSync(command, args, {
    cwd: options.cwd ?? reproDir,
    env: buildEnvironment(options.env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

const callGerrit = async <T>(
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
): Promise<T> => {
  const response = await fetch(`${gerrit}/a/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: adminAuthorization,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${text}`);
  }
  // Gerrit prefixes JSON responses with )]}' to prevent XSSI.
  return JSON.parse(text.slice(text.indexOf('\n') + 1)) as T;
};

const computeLabel = (mode: Mode): string => {
  if (mode.kind === 'released') {
    return 'released';
  }
  const commit = run('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: mode.renovateClone,
  }).trim();
  return `source-${commit}`;
};

const runRenovate = (
  mode: Mode,
  label: string,
  renovateRun: number,
  renovatePassword: string,
  work: string,
): void => {
  const name = `${label}-run${renovateRun}`;
  log(`Renovate run ${renovateRun} (${label}), log: logs/${name}.log`);
  rmSync(join(reproDir, 'logs', `${name}.log`), { force: true });
  rmSync(join(reproDir, 'logs', `${name}-packet.log`), { force: true });
  if (mode.kind === 'released') {
    run(
      'docker',
      [
        'compose',
        'run',
        '--rm',
        '--no-deps',
        '-e',
        `REPRO_RUN=${renovateRun}`,
        '-e',
        `RENOVATE_GERRIT_PASSWORD=${renovatePassword}`,
        '-e',
        `REPRO_GIT_TRACE_PACKET=/repro/logs/${name}-packet.log`,
        'renovate',
      ],
      { env: { GERRIT_PORT: gerritPort, LOG_NAME: name } },
    );
    return;
  }
  // Renovate lower-cases LOG_FILE, which breaks paths with capitals, so its
  // JSON output is written to the log instead.
  execFileSync('pnpm', ['--silent', 'start'], {
    cwd: mode.renovateClone,
    env: buildEnvironment({
      REPRO_RUN: String(renovateRun),
      RENOVATE_CONFIG_FILE: join(reproDir, 'config.js'),
      RENOVATE_GERRIT_PASSWORD: renovatePassword,
      GERRIT_URL: `${gerrit}/`,
      LOG_LEVEL: 'debug',
      LOG_FORMAT: 'json',
      REPRO_GIT_TRACE_PACKET: join(reproDir, 'logs', `${name}-packet.log`),
      RENOVATE_BASE_DIR: join(work, `renovate-run${renovateRun}`),
    }),
    stdio: [
      'ignore',
      openSync(join(reproDir, 'logs', `${name}.log`), 'w'),
      'inherit',
    ],
  });
};

const printOpenChanges = async (): Promise<void> => {
  log('Open changes of renovate');
  const changes = await callGerrit<readonly Change[]>(
    `changes/?q=owner:renovate+status:open+project:${project}`,
  );
  for (const change of changes) {
    console.log(`  ${change._number} ${change.subject}`);
  }
};

const moveMaster = (): void => {
  run('node', ['scripts/move-master.ts'], {
    env: { MOVE_MASTER_URL: projectUrl },
  });
};

const startCleanGerrit = (): void => {
  log(`Starting a clean Gerrit on ${gerrit}`);
  try {
    run('docker', ['compose', 'down', '-v', '--remove-orphans']);
  } catch (error) {
    console.trace('Stopping a previous Gerrit failed', error);
  }
  run('docker', ['compose', 'up', '-d', '--wait', 'gerrit'], {
    env: { GERRIT_PORT: gerritPort },
  });
  const logs = join(reproDir, 'logs');
  mkdirSync(logs, { recursive: true });
  // The Renovate container writes its logs as another user.
  chmodSync(logs, 0o777);
};

const createRenovateUser = async (): Promise<string> => {
  log('Creating user renovate (not an administrator)');
  const password = randomBytes(18).toString('base64');
  await callGerrit('accounts/renovate', {
    method: 'PUT',
    body: {
      name: 'Renovate',
      email: 'renovate@example.org',
      http_password: password,
    },
  });
  return password;
};

const createProject = async (work: string): Promise<void> => {
  log(`Creating project ${project} with an outdated package.json (commit A)`);
  await callGerrit(`projects/${project}`, {
    method: 'PUT',
    body: { branches: ['master'], create_empty_commit: true },
  });
  // Lets the administrator move master directly, standing for submitted changes.
  const administrators = await callGerrit<{ readonly id: string }>(
    'groups/Administrators',
  );
  await callGerrit(`projects/${project}/access`, {
    method: 'POST',
    body: {
      add: {
        'refs/heads/*': {
          permissions: {
            push: { rules: { [administrators.id]: { action: 'ALLOW' } } },
          },
        },
      },
    },
  });
  const seed = join(work, 'seed');
  run('git', ['clone', '--quiet', projectUrl, seed]);
  cpSync(join(reproDir, 'project'), seed, { recursive: true });
  run('git', ['add', '-A'], { cwd: seed });
  run(
    'git',
    [
      '-c',
      'user.name=Administrator',
      '-c',
      'user.email=admin@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'Add the demo project',
    ],
    { cwd: seed },
  );
  run('git', ['push', '--quiet', 'origin', 'HEAD:refs/heads/master'], {
    cwd: seed,
  });
  console.log(
    run('git', ['log', '-1', '--format=commit A %H, root tree %T'], {
      cwd: seed,
    }).trim(),
  );
};

const printRenovateReadAccess = async (): Promise<void> => {
  log(
    "renovate's read access to refs/meta/config (Gerrit checks pushed objects' reachability without it)",
  );
  const access = await callGerrit<{ readonly status: number; readonly message?: string }>(
    `projects/${project}/check.access?account=renovate&ref=refs/meta/config&perm=read`,
  );
  console.log(JSON.stringify({ status: access.status, message: access.message }));
};

const parseLogEntry = (line: string): LogEntry | undefined => {
  try {
    return JSON.parse(line) as LogEntry;
  } catch {
    return undefined;
  }
};

const printOutcome = (label: string): void => {
  const logName = `logs/${label}-run2.log`;
  log(`Outcome of run 2 per branch (${logName})`);
  const entries = readFileSync(join(reproDir, logName), 'utf8')
    .split('\n')
    .map(parseLogEntry)
    .filter((entry) => entry !== undefined)
    .filter((entry) =>
      /^(Commit prepared, push deferred|PR created|Pull request creation error|Reached (branch|PR) limit)/.test(
        entry.msg,
      ),
    );
  if (entries.length === 0) {
    throw new Error(
      `No push outcome in ${logName}: Renovate stopped before pushing, see that log`,
    );
  }
  for (const entry of entries) {
    const unpackError = entry.err?.message?.match(/remote unpack failed: [^\n]*/);
    const suffix = unpackError ? ` (${unpackError[0]})` : '';
    console.log(`  ${entry.branch}: ${entry.msg}${suffix}`);
  }
  const rejectedPushCount = entries
    .filter((entry) => entry.msg === 'Pull request creation error')
    .filter((entry) => entry.err?.message?.includes('Missing tree')).length;
  if (rejectedPushCount > 0) {
    log(`Reproduced: ${rejectedPushCount} pushes rejected with "Missing tree"`);
    return;
  }
  log('Not reproduced: no push was rejected with "Missing tree"');
};

const mode = parseMode(process.argv.slice(2));
const label = computeLabel(mode);
const work = mkdtempSync(join(tmpdir(), 'missing-tree-'));
try {
  startCleanGerrit();
  const renovatePassword = await createRenovateUser();
  await createProject(work);
  await printRenovateReadAccess();

  runRenovate(mode, label, 1, renovatePassword, work);
  await printOpenChanges();

  log('Advancing master by one commit (B)');
  moveMaster();

  runRenovate(mode, label, 2, renovatePassword, work);
  await printOpenChanges();

  printOutcome(label);
} finally {
  rmSync(work, { recursive: true, force: true });
}
