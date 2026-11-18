# Renovate on Gerrit: "Missing tree" when the target branch moves during a run

A Renovate run on Gerrit fails to create every new change with:

```
error: remote unpack failed: error Missing tree <sha>
```

as soon as the target branch moves on the server after Renovate fetched it,
provided Renovate has an older open change on that branch. Since a change whose
push fails is never created, `prConcurrentLimit` and `prHourlyLimit` never stop
the run: it attempts, and fails, every pending update.

Discussion: https://github.com/renovatebot/renovate/discussions/48167
Proposed fix: https://github.com/renovatebot/renovate/pull/48168
Root cause in JGit: https://github.com/eclipse-jgit/jgit/issues/316

## What happens

1. Renovate's open change X was created on top of master commit A.
2. Master moves to B. A Renovate run clones the repository at B.
3. While the run prepares a new update C (based on B), someone submits a change:
   master moves to D on the server. Renovate's clone does not have D.
4. Renovate pushes C to `refs/for/master`. Gerrit advertises `refs/heads/master`
   (D, unknown to the client) and X as `.have` (Gerrit advertises the pusher's
   open changes). The only common commit git finds is X, so it sends the
   commits after A up to C as a thin pack whose trees are deltified against
   A's trees, which it leaves out.
5. Gerrit makes JGit check that every object the pack references is reachable
   when the pusher cannot read every ref, which includes any user without read
   on `refs/meta/config`. A is not advertised, so JGit does not count its root
   tree as reachable, reports it missing and rejects the pack (details in the
   JGit issue).

Fetching the target branch right before the push (the proposed fix) gives git
the advertised tip D: git excludes it and sends only C, deltified against its
parent B, a boundary commit whose tree JGit accepts.

## Reproduction

Prerequisites: Docker with Compose v2, git, Node.js 24 or later (it runs the
TypeScript scripts directly). Port 8080 on localhost must be free (or set
`GERRIT_PORT`). To run Renovate from source, also a Renovate checkout with its
dependencies installed (`pnpm install`).

```sh
node scripts/run.ts released                 # renovate/renovate:44.249.2
node scripts/run.ts source ~/src/renovate    # any Renovate checkout, via pnpm start
docker compose down -v                       # clean up
```

Each invocation takes about 40 seconds once the images are pulled. It starts a
fresh Gerrit 3.14.6 (development auth, default `admin`/`secret`) and then:

1. creates a non-administrator user `renovate` and the project
   `missing-tree-demo` (commit A) whose `package.json` has four outdated
   dependencies, and checks that `renovate` lacks read on `refs/meta/config`;
2. Renovate run 1 creates a single change, for `is-number`;
3. the administrator pushes two commits to master (B);
4. Renovate run 2 processes the three other updates with
   `prConcurrentLimit: 2`, so it may create one more change. The `ms` update
   goes first (`prPriority`) and has a post-upgrade task,
   [`scripts/move-master.ts`](scripts/move-master.ts), that pushes a commit to
   master from a separate clone: master moves after Renovate's fetch and before
   its push, every time.

Renovate logs (debug) and git packet traces go to `logs/`.

## Current behavior

Output with Renovate 44.249.2:

```
==> Creating project missing-tree-demo with an outdated package.json (commit A)
commit A 907375ea8cc7e1e7b21c6e9d92bcb3a5391c1de2, root tree 7684b2c10b2c1275ee47f74d442b2e112e32f12d

==> renovate's read access to refs/meta/config (Gerrit checks pushed objects' reachability without it)
{"status":403,"message":"user 1000001 lacks permission read for refs/meta/config in project missing-tree-demo"}
...
==> Open changes of renovate
  1 Update dependency is-number to v7

==> Outcome of run 2 per branch (logs/released-run2.log)
  renovate/ms-2.x: Commit prepared, push deferred to createPr()
  renovate/ms-2.x: Pull request creation error (remote unpack failed: error Missing tree 7684b2c10b2c1275ee47f74d442b2e112e32f12d)
  renovate/left-pad-1.x: Commit prepared, push deferred to createPr()
  renovate/left-pad-1.x: Pull request creation error (remote unpack failed: error Missing tree 7684b2c10b2c1275ee47f74d442b2e112e32f12d)
  renovate/escape-string-regexp-5.x: Commit prepared, push deferred to createPr()
  renovate/escape-string-regexp-5.x: Pull request creation error (remote unpack failed: error Missing tree 7684b2c10b2c1275ee47f74d442b2e112e32f12d)
```

The missing tree is the root tree of commit A, the parent of the open change.
No change is created, and all three updates are attempted despite the limit.
The packet trace of the failing push shows the advertisement:

```
git< <D> refs/heads/master\0 side-band-64k delete-refs report-status ...
git< <X> .have
git< unpack error Missing tree 7684b2c10b2c1275ee47f74d442b2e112e32f12d
git< ng refs/for/master n/a (unpacker error)
```

## Expected behavior

Renovate creates the change, then stops at the limit. Output with the proposed
fix:

```
==> Open changes of renovate
  2 Update dependency ms to v2.1.3
  1 Update dependency is-number to v7

==> Outcome of run 2 per branch (logs/source-d38090a431-run2.log)
  renovate/ms-2.x: Commit prepared, push deferred to createPr()
  renovate/ms-2.x: PR created
  renovate/left-pad-1.x: Reached branch limit - skipping branch creation
  renovate/escape-string-regexp-5.x: Reached branch limit - skipping branch creation
```

## Files

- [`docker-compose.yml`](docker-compose.yml): Gerrit, and the released Renovate image (profile `renovate`)
- [`config.js`](config.js): self-hosted Renovate configuration for both runs
- [`project/`](project): content of the demo project's first commit
- [`scripts/run.ts`](scripts/run.ts): the whole scenario, from a clean Gerrit
- [`scripts/move-master.ts`](scripts/move-master.ts): pushes a commit to master from a separate clone
