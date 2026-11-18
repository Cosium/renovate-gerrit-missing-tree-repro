// Submits a commit to master from a separate clone, so that Renovate's own
// clone does not get the new tip. Run by Renovate as a post-upgrade task.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const projectUrl = process.env.MOVE_MASTER_URL;
if (!projectUrl) {
  console.error('MOVE_MASTER_URL is not set');
  process.exit(2);
}

const clone = mkdtempSync(join(tmpdir(), 'move-master-'));
const git = (args: readonly string[]): string =>
  execFileSync('git', args, { cwd: clone, encoding: 'utf8' });
try {
  git(['clone', '--quiet', projectUrl, '.']);
  appendFileSync(
    join(clone, 'CHANGELOG.md'),
    `Moved while Renovate was running: ${new Date().toISOString()}\n`,
  );
  git(['add', 'CHANGELOG.md']);
  git([
    '-c',
    'user.name=Administrator',
    '-c',
    'user.email=admin@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'Update changelog while Renovate runs',
  ]);
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/master']);
  console.log(`master moved to ${git(['rev-parse', 'HEAD']).trim()}`);
} finally {
  rmSync(clone, { recursive: true, force: true });
}
