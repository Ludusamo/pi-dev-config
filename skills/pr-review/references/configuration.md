# Configuration

Where reviews are stored, and how to change it.

## Two roots

| Root            | Holds                                  | Lifetime                                  | Default              |
| --------------- | -------------------------------------- | ----------------------------------------- | -------------------- |
| `worktree_root` | base/head git checkouts                | Deleted after the review                  | `~/reviews`          |
| `artifact_root` | guides, scans, verdicts, `record.json` | Permanent - the retro reads across months | `~/pi-artifacts/pr-reviews` |

They are separate on purpose.
Worktrees are bulky and disposable; artifacts are small and durable.
Keeping worktrees out of a notes directory also matters if that directory is an Obsidian vault or is synced - a Java checkout will wreck the indexer.

## Resolution order

Highest wins:

1. CLI flag - `--worktree-root`, `--artifact-root`
2. Environment - `PR_REVIEW_WT_ROOT`, `PR_REVIEW_ARTIFACT_ROOT`
3. Per-repo block - `repos.<repo-name>` in the config file
4. Global block - top level of the config file
5. Built-in default

`prconfig.py show` prints the resolved values and which rule produced each one.
Run it first whenever artifacts end up somewhere unexpected.

## Config file

| Platform | Path                                                         |
| -------- | ------------------------------------------------------------ |
| POSIX    | `$XDG_CONFIG_HOME/pr-review/config.json`, else `~/.config/pr-review/config.json` |
| Windows  | `%APPDATA%\pr-review\config.json`                            |

```json
{
  "worktree_root": "~/reviews",
  "artifact_root": "~/pi-artifacts/pr-reviews",
  "autocommit": false,
  "repos": {
    "cod-backend": {
      "worktree_root": "/mnt/fast/reviews",
      "artifact_root": "~/work/review-log"
    }
  }
}
```

Every key is optional.
`~` and environment variables are expanded.
A malformed config is a hard error rather than a silent fallback - scattering artifacts into a default location is worse than refusing to run.

Note that personal paths belong here, not in a repository's `REVIEW_STANDARDS.md`.
That file is committed and team-visible; its `# Config` section is for repo facts like `subsystem_re`.

## Per-repo overrides

Keyed by repository directory name, which is what `git rev-parse --show-toplevel` yields.
Useful when one repo needs different treatment:

- A huge repo whose worktrees should land on a faster or larger disk.
- A work repo whose review records must stay out of a personal notes vault.
- A repo whose records go in a shared log that teammates can read.

## The artifact root as a git repo

Records are the input to the retro loop, so they are worth version control, and they need to be the same on every machine you review from.

```
prconfig.py init --git          create both roots, git init the artifact root
prconfig.py sync -m "STONE-1458"  commit everything under the artifact root
prconfig.py sync --push         commit and push
```

`sync` is a no-op with a clear reason when the artifact root is not a repo, or when there is nothing to commit, so it is safe to call unconditionally at the end of a review.

When the artifact root is not a repo, `sync` also prints a one-line warning suggesting `git init` and `"autocommit": true`.
It repeats on every sync until `autocommit` is set explicitly in the config file, to either `true` or `false`.
Setting `"autocommit": false` is how you say "unversioned on purpose" and silence it.

Add a remote yourself.
Nothing in the pipeline creates or infers one.

## Verifying a setup

```
prconfig.py show                    # resolved paths, with provenance
prconfig.py init --write-config     # materialize the current values as a config file
review_worktree.py list             # existing worktrees under the resolved root
```

`init --write-config` only writes when no config file exists; it will not overwrite one.
