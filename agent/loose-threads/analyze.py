#!/usr/bin/env python3
"""Read-only analysis of local branches/worktrees across repos. Writes refs.json."""
import json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

BASE = "/Volumes/sourcecode/repos"
OUT = os.environ["LT_OUT"]
NOW = time.time()

def git(repo, *args, check=False):
    p = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    return p.returncode, p.stdout.strip()

def gh_prs(slug, branch):
    if not slug or "/" not in slug or slug.startswith("http"):
        return None
    p = subprocess.run(["gh", "pr", "list", "--repo", slug, "--head", branch, "--state", "all",
                        "--json", "number,state,mergedAt,title,url,headRefName,baseRefName"],
                       capture_output=True, text=True)
    if p.returncode != 0:
        return {"error": p.stderr.strip()[:200]}
    return json.loads(p.stdout or "[]")

def analyze_repo(rel):
    repo = os.path.join(BASE, rel)
    _, slug = git(repo, "remote", "get-url", "origin")
    m = re.search(r"github\.com[:/](.+?)(\.git)?$", slug)
    slug = m.group(1) if m else ""
    rc, d = git(repo, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD")
    if rc != 0 or not d:
        d = None
        for c in ("origin/main", "origin/master", "origin/development"):
            if git(repo, "rev-parse", "-q", "--verify", c)[0] == 0:
                d = c; break
    defname = d.split("/", 1)[1] if d else None
    deftree = git(repo, "rev-parse", f"{d}^{{tree}}")[1] if d else None
    # worktrees
    _, wl = git(repo, "worktree", "list", "--porcelain")
    wts = []
    cur = {}
    for line in wl.splitlines() + [""]:
        if not line:
            if cur: wts.append(cur); cur = {}
            continue
        k, _, v = line.partition(" ")
        cur[k] = v if v else True
    main_wt = wts[0]["worktree"] if wts else repo
    br2wt = {}
    for w in wts:
        if "branch" in w:
            br2wt[w["branch"].removeprefix("refs/heads/")] = w["worktree"]
    _, refs = git(repo, "for-each-ref", "--format=%(refname:short)|%(upstream:short)|%(upstream:track)|%(committerdate:unix)|%(objectname)", "refs/heads")
    items = []
    targets = []
    for line in refs.splitlines():
        b, up, tr, ct, sha = line.split("|")
        targets.append(("branch", b, up, tr, int(ct or 0), sha))
    for w in wts[1:]:
        if "detached" in w:
            targets.append(("detached", None, "", "", 0, w.get("HEAD")))
    if wts and "detached" in wts[0]:
        targets.append(("detached-main", None, "", "", 0, wts[0].get("HEAD")))
    for kind, b, up, tr, ct, sha in targets:
        it = {"repo": rel, "slug": slug, "kind": kind, "branch": b, "sha": sha, "default": d}
        ref = b if b else sha
        if kind != "branch":
            it["worktree"] = next((w["worktree"] for w in wts if w.get("HEAD") == sha and "detached" in w), None)
            ct = int(git(repo, "log", "-1", "--format=%ct", sha)[1] or 0)
        else:
            it["worktree"] = br2wt.get(b)
        it["is_main_checkout"] = it["worktree"] == main_wt
        it["commit_age_h"] = round((NOW - ct) / 3600, 1) if ct else None
        if b:
            rc, rl = git(repo, "reflog", "show", "--date=unix", "--format=%gd", "-1", b)
            mm = re.search(r"\{(\d+)\}", rl)
            it["reflog_age_h"] = round((NOW - int(mm.group(1))) / 3600, 1) if mm else None
        it["upstream"] = up or None
        it["upstream_gone"] = "[gone]" in tr
        if up and not it["upstream_gone"]:
            it["unpushed"] = int(git(repo, "rev-list", "--count", f"{up}..{ref}")[1] or 0)
        if d:
            lr = git(repo, "rev-list", "--left-right", "--count", f"{d}...{ref}")[1].split()
            it["behind"], it["ahead"] = (int(lr[0]), int(lr[1])) if len(lr) == 2 else (None, None)
            if it.get("ahead"):
                rc, mt = git(repo, "merge-tree", "--write-tree", "--name-only", d, ref)
                tree = mt.splitlines()[0] if mt else ""
                if rc == 0:
                    it["merge_result"] = "content-in-default" if tree == deftree else "adds-changes"
                    if tree != deftree:
                        _, ns = git(repo, "diff", "--name-only", d, tree)
                        it["diff_files"] = len(ns.splitlines())
                        it["diff_files_sample"] = ns.splitlines()[:8]
                else:
                    it["merge_result"] = "conflict"
                    it["conflict_files"] = [l for l in mt.splitlines()[1:] if l and not l.startswith("Auto-merging") and not l.startswith("CONFLICT")][:8]
                # cherry: commits without equivalent patch in default
                _, ch = git(repo, "cherry", d, ref)
                it["cherry_unique"] = sum(1 for l in ch.splitlines() if l.startswith("+"))
        _, rc_ = git(repo, "branch", "-r", "--contains", ref)
        it["remote_branches_containing"] = [x.strip() for x in rc_.splitlines() if "->" not in x][:5]
        if it["worktree"] and os.path.isdir(it["worktree"]):
            _, st = git(it["worktree"], "status", "--porcelain")
            lines = st.splitlines()
            it["dirty"] = len(lines)
            it["untracked"] = sum(1 for l in lines if l.startswith("??"))
            it["dirty_sample"] = lines[:10]
        elif it["worktree"]:
            it["worktree_missing"] = True
        mi = re.search(r"(?:^|[/_-])(?:pr)?(\d{2,5})(?=$|[-_/])", b or "")
        it["number_hint"] = int(mi.group(1)) if mi else None
        if b and b != defname and slug:
            it["prs"] = gh_prs(slug, b)
        items.append(it)
    return {"repo": rel, "slug": slug, "default": d, "worktrees": [w["worktree"] for w in wts], "items": items}

def main():
    repos = [l.strip().removeprefix("./") for l in open(os.path.join(OUT, "repos.txt")) if l.strip()]
    with ThreadPoolExecutor(8) as ex:
        res = list(ex.map(analyze_repo, repos))
    json.dump(res, open(os.path.join(OUT, "refs.json"), "w"), indent=1)
    print(sum(len(r["items"]) for r in res), "items")

main()
