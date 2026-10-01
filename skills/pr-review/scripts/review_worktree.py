#!/usr/bin/env python3
"""review_worktree.py - materialize base/head worktrees for a PR/MR review.

Git-native: takes two refs, resolves the merge-base, and checks out detached
worktrees so the reviewer's own working tree is never disturbed.

Roots are configurable - see prconfig.py. Defaults shown below.

Layout:
    ~/reviews/<repo>/<id>/base@<sha7>/     merge-base(base, head)
    ~/reviews/<repo>/<id>/head@<sha7>/     head commit
    ~/reviews/<repo>/<id>/base -> base@...  convenience symlink, POSIX only
    ~/reviews/<repo>/<id>/head -> head@...

The symlinks are a nicety, not a contract: creating one on Windows needs admin
or Developer Mode. Always consume `.worktrees.base` / `.worktrees.head` from
this script's JSON output, which resolve to real directories on every platform.

SHA-named directories mean a force-push produces a new worktree alongside the
old one, which is what makes an incremental "what changed since my last pass"
diff possible.

Usage:
    review_worktree.py add --base origin/main --head origin/feature/x --id OPST-4216
    review_worktree.py add --head origin/feature/x --sparse
    review_worktree.py list
    review_worktree.py clean --id OPST-4216          # from any directory
    review_worktree.py clean --all --older-than 14   # this repo only
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prconfig  # noqa: E402  (same directory, no package)


def git(*args, cwd=None, check=True):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and r.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout.strip()


def repo_root(start=None):
    return Path(git("rev-parse", "--show-toplevel", cwd=start))


def slug(s):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-") or "review"


def live_worktrees(repo):
    out = git("worktree", "list", "--porcelain", cwd=repo)
    return {
        line.split(" ", 1)[1]
        for line in out.splitlines()
        if line.startswith("worktree ")
    }


def resolve(repo, ref):
    sha = git("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", cwd=repo, check=False)
    if not sha:
        sys.exit(f"cannot resolve ref: {ref}")
    return sha


def cmd_add(args):
    repo = repo_root()
    wt_root, artifact_root = prconfig.roots(
        repo.name, {"worktree_root": args.worktree_root,
                    "artifact_root": args.artifact_root})
    git("worktree", "prune", cwd=repo)

    if args.fetch:
        # Best effort: offline or a local-only ref should not be fatal.
        git("fetch", "--prune", args.remote, cwd=repo, check=False)

    head_sha = resolve(repo, args.head)
    base_sha = git("merge-base", args.base, head_sha, cwd=repo)
    if base_sha == head_sha:
        sys.exit("base and head resolve to the same commit - nothing to review")

    rid = slug(args.id or args.head.rsplit("/", 1)[-1])
    out_dir = wt_root / repo.name / rid
    out_dir.mkdir(parents=True, exist_ok=True)

    existing = live_worktrees(repo)
    paths, reused, symlinks_ok = {}, {}, []

    for role, sha in (("base", base_sha), ("head", head_sha)):
        target = out_dir / f"{role}@{sha[:7]}"
        reused[role] = str(target) in existing and target.exists()

        if not reused[role]:
            if target.exists():
                git("worktree", "remove", "--force", str(target), cwd=repo, check=False)
            add_cmd = ["worktree", "add", "--detach"]
            if args.sparse:
                add_cmd.append("--no-checkout")
            git(*add_cmd, str(target), sha, cwd=repo)

            if args.sparse:
                changed = git(
                    "diff", "--name-only", f"{base_sha}..{head_sha}", cwd=repo
                ).splitlines()
                dirs = sorted({str(Path(f).parent) for f in changed if f})
                if dirs:
                    git("sparse-checkout", "set", "--no-cone", *dirs, cwd=target)
                git("checkout", cwd=target)

        paths[role] = str(target)
        link = out_dir / role
        try:
            if link.is_symlink() or link.is_file():
                link.unlink()
            if not link.exists():
                link.symlink_to(target.name, target_is_directory=True)
                paths[role] = str(link)
            elif link.is_symlink():
                paths[role] = str(link)
        except (OSError, NotImplementedError):
            # Windows without Developer Mode. The SHA-named path still works.
            symlinks_ok.append(False)

    artifacts = artifact_root / repo.name / rid
    artifacts.mkdir(parents=True, exist_ok=True)

    info = {
        "repo": repo.name,
        "repo_path": str(repo),
        "id": rid,
        "base_ref": args.base,
        "base_sha": base_sha,
        "head_ref": args.head,
        "head_sha": head_sha,
        "range": f"{base_sha}..{head_sha}",
        "worktrees": paths,
        "reused": reused,
        "symlinked": not symlinks_ok,
        "sparse": bool(args.sparse),
        "artifacts": str(artifacts),
    }

    state_path = artifacts / ".state.json"
    state = {"passes": []}
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text())
        except json.JSONDecodeError:
            pass
    passes = state.setdefault("passes", [])
    if not passes or passes[-1].get("head_sha") != head_sha:
        passes.append({"head_sha": head_sha, "base_sha": base_sha, "at": int(time.time())})
    state.update({k: info[k] for k in ("repo", "id", "base_ref", "head_ref")})
    state_path.write_text(json.dumps(state, indent=2) + "\n")

    if len(passes) > 1 and passes[-1]["head_sha"] == head_sha:
        prev = passes[-2]["head_sha"]
        if prev != head_sha:
            info["since_last_pass"] = f"{prev}..{head_sha}"

    print(json.dumps(info, indent=2))


def cmd_list(args):
    repo = repo_root()
    wt_root, _ = prconfig.roots(repo.name, {"worktree_root": args.worktree_root})
    base = wt_root / repo.name
    rows = []
    if base.exists():
        for review in sorted(base.iterdir()):
            if not review.is_dir():
                continue
            wts = sorted(p.name for p in review.glob("*@*"))
            rows.append(
                {
                    "id": review.name,
                    "path": str(review),
                    "worktrees": wts,
                    "age_days": round((time.time() - review.stat().st_mtime) / 86400, 1),
                }
            )
    print(json.dumps({"repo": repo.name, "reviews": rows}, indent=2))


def source_repo_of(review_dir):
    """The repository a review's worktrees belong to, read from the worktrees.

    A linked worktree's .git is a file, "gitdir: <repo>/.git/worktrees/<name>".
    Two levels up from that gitdir is the source repo's .git directory, and its
    parent is the repo. This is what lets clean run from any directory.
    """
    for wt in sorted(review_dir.glob("*@*")):
        dotgit = wt / ".git"
        if not dotgit.is_file():
            continue
        for line in dotgit.read_text().splitlines():
            if line.startswith("gitdir:"):
                gitdir = Path(line.split(":", 1)[1].strip())
                if not gitdir.is_absolute():
                    gitdir = (wt / gitdir).resolve()
                common = gitdir.parent.parent  # .../.git/worktrees/<name> -> .../.git
                if common.name == ".git" and common.parent.exists():
                    return common.parent
                if common.exists():  # bare repo
                    return common
    return None


def cmd_clean(args):
    rid = slug(args.id) if args.id else None
    if not (args.all or rid):
        sys.exit("pass --id <id> or --all")

    # With --id, find the review under any repo, so the cwd does not matter.
    # --all stays scoped to the current repo; sweeping every repo is too broad.
    repo = None
    if args.all:
        repo = repo_root()
        wt_root, _ = prconfig.roots(repo.name, {"worktree_root": args.worktree_root})
        base = wt_root / repo.name
        targets = [p for p in base.iterdir() if p.is_dir()] if base.exists() else []
    else:
        wt_root, _ = prconfig.roots(None, {"worktree_root": args.worktree_root})
        targets = sorted(p for p in wt_root.glob(f"*/{rid}") if p.is_dir())
        # A per-repo worktree_root override puts it elsewhere; try the cwd's repo.
        here = prconfig.repo_name_from(".")
        if not targets and here:
            wt_here, _ = prconfig.roots(here, {"worktree_root": args.worktree_root})
            if (wt_here / here / rid).is_dir():
                targets = [wt_here / here / rid]
        if len(targets) > 1:
            sys.exit(f"id {rid} exists under more than one repo: "
                     f"{', '.join(str(t) for t in targets)} - remove one by hand")

    cleaned, repos = [], set()
    cutoff = time.time() - (args.older_than * 86400) if args.older_than else None
    for review in targets:
        if not review.exists():
            continue
        if cutoff is not None and review.stat().st_mtime > cutoff:
            continue
        src = repo or source_repo_of(review)
        if src is None:
            print(f"warning: cannot find the source repo for {review}; "
                  f"leaving it in place", file=sys.stderr)
            continue
        repos.add(src)
        for wt in sorted(review.glob("*@*")):
            git("worktree", "remove", "--force", str(wt), cwd=src, check=False)
        for link in ("base", "head"):
            p = review / link
            try:
                if p.is_symlink():
                    p.unlink()
            except OSError:
                pass
        try:
            review.rmdir()
        except OSError:
            pass  # leftover files - leave them rather than rm -rf
        cleaned.append(str(review))

    for src in repos:
        git("worktree", "prune", cwd=src, check=False)

    # One line for the human: what went, and what deliberately stayed.
    if cleaned and rid:
        repo_name = Path(cleaned[0]).parent.name
        _, art_root = prconfig.roots(repo_name)
        print(f"Worktrees removed; record and notes kept at {art_root / repo_name / rid}/",
              file=sys.stderr)
    elif cleaned:
        print(f"Worktrees removed for {len(cleaned)} review(s); records and notes kept "
              f"under the artifact root", file=sys.stderr)
    print(json.dumps({"cleaned": cleaned}, indent=2))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add", help="create/reuse base+head worktrees")
    a.add_argument("--base", default="origin/HEAD", help="base ref (default origin/HEAD)")
    a.add_argument("--head", default="HEAD", help="head ref (default HEAD)")
    a.add_argument("--id", help="review id, e.g. OPST-4216 (default: head branch name)")
    a.add_argument("--remote", default="origin")
    a.add_argument("--no-fetch", dest="fetch", action="store_false",
                   help="skip the pre-fetch")
    a.add_argument("--sparse", action="store_true",
                   help="check out only directories touched by the diff")
    prconfig.add_root_args(a)
    a.set_defaults(fn=cmd_add)

    l = sub.add_parser("list", help="list review worktrees for this repo")
    prconfig.add_root_args(l)
    l.set_defaults(fn=cmd_list)

    c = sub.add_parser("clean", help="remove review worktrees")
    c.add_argument("--id")
    c.add_argument("--all", action="store_true")
    c.add_argument("--older-than", type=float, metavar="DAYS")
    prconfig.add_root_args(c)
    c.set_defaults(fn=cmd_clean)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
