// Self-hosted Renovate configuration shared by the Docker image and a
// Renovate checkout run from source. scripts/run.ts sets the environment.
const path = require('node:path');

const gerritUrl = process.env.GERRIT_URL ?? 'http://localhost:8080/';
const project = 'missing-tree-demo';
// Run 1 creates a single change; run 2 processes every pending update.
const run = process.env.REPRO_RUN ?? '2';

module.exports = {
  platform: 'gerrit',
  endpoint: gerritUrl,
  username: 'renovate',
  password: process.env.RENOVATE_GERRIT_PASSWORD,
  repositories: [project],
  onboarding: false,
  requireConfig: 'optional',
  gitAuthor: 'Renovate <renovate@example.org>',
  // Run 1 leaves one open change, so run 2 may create one more and should then
  // stop with "Reached branch limit". A change whose push fails is not counted.
  prHourlyLimit: 0,
  prConcurrentLimit: 2,
  allowedCommands: ['^node .*/move-master\\.ts$'],
  customEnvVariables: {
    MOVE_MASTER_URL: `${gerritUrl.replace('://', '://admin:secret@')}a/${project}`,
    // Git protocol trace of every git command Renovate runs.
    ...(process.env.REPRO_GIT_TRACE_PACKET && {
      GIT_TRACE_PACKET: process.env.REPRO_GIT_TRACE_PACKET,
    }),
  },
  packageRules: [
    {
      matchPackageNames: ['*'],
      enabled: run === '2',
    },
    {
      matchPackageNames: ['is-number'],
      enabled: true,
    },
    {
      // Processed first in run 2. While Renovate prepares this update, after
      // its fetch and before its push, someone else submits a change to master.
      matchPackageNames: ['ms'],
      prPriority: 10,
      postUpgradeTasks: {
        commands: [`node ${path.join(__dirname, 'scripts', 'move-master.ts')}`],
        executionMode: 'branch',
      },
    },
  ],
};
