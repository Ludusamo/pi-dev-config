#!/usr/bin/env python3
"""prconfig.py - where reviews are stored, and how that location is configured.

Two roots:

    worktree_root   bulky, disposable git checkouts     default ~/reviews
    artifact_root   small, durable guides and records   default ~/notes/pr-reviews

They are separate because they have opposite lifetimes. Worktrees are deleted
after a review; artifacts and records must outlive the branch, since the retro
loop reads across months of them.

Resolution order, highest wins:

    1. CLI flag                 --artifact-root / --worktree-root
    2. Environment variable     PR_REVIEW_ARTIFACT_ROOT / PR_REVIEW_WT_ROOT
    3. Per-repo config block    repos.<repo-name> in the config file
    4. Global config block      top level of the config file
    5. Built-in default

Config file (JSON, all keys optional):

    ~/.config/pr-review/config.json          POSIX, or $XDG_CONFIG_HOME
    %APPDATA%\\pr-review\\config.json          Windows

    {
      "artifact_root": "~/notes/pr-reviews",
      "worktree_root": "~/reviews",
      "autocommit": false,
      "repos": {
        "cod-backend": {
          "artifact_root": "~/work/review-log",
          "worktree_root": "/mnt/fast/reviews"
        }
      }
    }

Usage:
    prconfig.py show [--repo-path .]        resolved paths and where each came from
    prconfig.py init [--git]                create the roots, optionally git init artifacts
    prconfig.py sync [--push]               commit (and optionally push) the artifact root
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

DEFAULTS = {
    "worktree_root": Path.home() / "reviews",
    "artifact_root": Path.home() / "notes" / "pr-reviews",
    "autocommit": False,
}

ENV = {
    "worktree_root": "PR_REVIEW_WT_ROOT",
    "artifact_root": "PR_REVIEW_ARTIFACT_ROOT",
}


def config_path():
    if os.name == "nt":
        base = os.environ.get("APPDATA")
        if base:
            return Path(base) / "pr-review" / "config.json"
    base = os.environ.get("XDG_CONFIG_HOME")
    root = Path(base) if base else Path.home() / ".config"
    return root / "pr-review" / "config.json"


def load_file():
    p = config_path()
    if not p.exists():
        return {}, None
    try:
        return json.loads(p.read_text()), p
    except (json.JSONDecodeError, OSError) as e:
        # A broken config must not silently fall back to defaults and scatter
        # artifacts somewhere unexpected.
        sys.exit(f"cannot read config {p}: {e}")


def expand(value):
    return Path(os.path.expandvars(str(value))).expanduser()


def resolve(repo_name=None, overrides=None):
    """Resolve both roots. Returns {key: {"path": Path, "source": str}}."""
    cfg, cfg_file = load_file()
    repo_cfg = (cfg.get("repos") or {}).get(repo_name or "", {})
    overrides = {k: v for k, v in (overrides or {}).items() if v}
    out = {}

    for key, default in DEFAULTS.items():
        if key == "autocommit":
            continue
        if key in overrides:
            out[key] = {"path": expand(overrides[key]), "source": "cli flag"}
        elif os.environ.get(ENV[key]):
            out[key] = {"path": expand(os.environ[ENV[key]]),
                        "source": f"env {ENV[key]}"}
        elif key in repo_cfg:
            out[key] = {"path": expand(repo_cfg[key]),
                        "source": f"config repos.{repo_name}"}
        elif key in cfg:
            out[key] = {"path": expand(cfg[key]), "source": "config global"}
        else:
            out[key] = {"path": Path(default), "source": "default"}

    out["autocommit"] = {
        "value": bool(repo_cfg.get("autocommit", cfg.get("autocommit", False))),
        "source": "config",
    }
    out["_config_file"] = str(cfg_file) if cfg_file else None
    return out


def roots(repo_name=None, overrides=None):
    """Convenience: just the two paths."""
    r = resolve(repo_name, overrides)
    return r["worktree_root"]["path"], r["artifact_root"]["path"]


def add_root_args(parser):
    parser.add_argument("--worktree-root", help="override where worktrees are created")
    parser.add_argument("--artifact-root", help="override where artifacts are written")


def add_repo_arg(parser):
    # On each subparser rather than the top level: argparse would otherwise
    # require it before the subcommand, which nobody expects.
    parser.add_argument("--repo-path", default=".",
                        help="repository to resolve config for (default: cwd)")


# --- git helpers for an artifact root that is a repo ------------------------

def is_git_repo(path):
    r = subprocess.run(["git", "-C", str(path), "rev-parse", "--is-inside-work-tree"],
                       capture_output=True, text=True)
    return r.returncode == 0 and r.stdout.strip() == "true"


def commit_artifacts(artifact_root, message, push=False):
    """Commit everything under the artifact root. No-op when it is not a repo."""
    if not artifact_root.exists() or not is_git_repo(artifact_root):
        return {"committed": False, "reason": "artifact root is not a git repo"}

    def g(*args, check=False):
        return subprocess.run(["git", "-C", str(artifact_root), *args],
                              capture_output=True, text=True, check=check)

    g("add", "-A")
    if not g("diff", "--cached", "--quiet").returncode:
        return {"committed": False, "reason": "nothing to commit"}
    r = g("commit", "-m", message)
    if r.returncode:
        return {"committed": False, "reason": r.stderr.strip()}
    result = {"committed": True, "message": message}
    if push:
        p = g("push")
        result["pushed"] = p.returncode == 0
        if p.returncode:
            result["push_error"] = p.stderr.strip()
    return result


# --- CLI --------------------------------------------------------------------

def repo_name_from(path):
    r = subprocess.run(["git", "-C", str(path), "rev-parse", "--show-toplevel"],
                       capture_output=True, text=True)
    return Path(r.stdout.strip()).name if r.returncode == 0 else None


def cmd_show(args):
    name = repo_name_from(args.repo_path)
    r = resolve(name, {"worktree_root": args.worktree_root,
                       "artifact_root": args.artifact_root})
    out = {
        "repo": name,
        "config_file": r["_config_file"] or f"{config_path()} (not present)",
        "worktree_root": str(r["worktree_root"]["path"]),
        "worktree_root_source": r["worktree_root"]["source"],
        "artifact_root": str(r["artifact_root"]["path"]),
        "artifact_root_source": r["artifact_root"]["source"],
        "artifact_root_is_git": is_git_repo(r["artifact_root"]["path"])
                                if r["artifact_root"]["path"].exists() else False,
        "autocommit": r["autocommit"]["value"],
    }
    if name:
        out["review_dir"] = str(r["artifact_root"]["path"] / name)
    print(json.dumps(out, indent=2))


def cmd_init(args):
    name = repo_name_from(args.repo_path)
    wt, art = roots(name, {"worktree_root": args.worktree_root,
                           "artifact_root": args.artifact_root})
    wt.mkdir(parents=True, exist_ok=True)
    art.mkdir(parents=True, exist_ok=True)
    created = []
    if args.git and not is_git_repo(art):
        subprocess.run(["git", "-C", str(art), "init", "-q"], check=True)
        gi = art / ".gitignore"
        if not gi.exists():
            gi.write_text("# review artifacts are small and durable; worktrees are not here\n")
        created.append("git repo")

    cfg_file = config_path()
    if args.write_config and not cfg_file.exists():
        cfg_file.parent.mkdir(parents=True, exist_ok=True)
        cfg_file.write_text(json.dumps({
            "worktree_root": str(wt), "artifact_root": str(art),
            "autocommit": False, "repos": {},
        }, indent=2) + "\n")
        created.append(str(cfg_file))

    print(json.dumps({"worktree_root": str(wt), "artifact_root": str(art),
                      "created": created}, indent=2))


def cmd_sync(args):
    name = repo_name_from(args.repo_path)
    _, art = roots(name, {"artifact_root": args.artifact_root})
    msg = args.message or "review artifacts"
    print(json.dumps(commit_artifacts(art, msg, push=args.push), indent=2))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("show", help="print resolved paths and their source")
    add_root_args(s); add_repo_arg(s); s.set_defaults(fn=cmd_show)

    i = sub.add_parser("init", help="create the roots")
    add_root_args(i); add_repo_arg(i)
    i.add_argument("--git", action="store_true", help="git init the artifact root")
    i.add_argument("--write-config", action="store_true",
                   help="write a config file with the resolved values")
    i.set_defaults(fn=cmd_init)

    y = sub.add_parser("sync", help="commit the artifact root, if it is a git repo")
    y.add_argument("--artifact-root")
    y.add_argument("--worktree-root", help=argparse.SUPPRESS)
    add_repo_arg(y)
    y.add_argument("--push", action="store_true")
    y.add_argument("-m", "--message")
    y.set_defaults(fn=cmd_sync)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
