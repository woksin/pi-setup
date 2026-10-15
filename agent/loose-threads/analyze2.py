#!/usr/bin/env python3
"""Second pass: PR head ancestry proof + issue lookup. Read-only except git object fetches."""
import json, os, re, subprocess
from concurrent.futures import ThreadPoolExecutor
OUT = os.environ["LT_OUT"]
BASE = "/Volumes/sourcecode/repos"
res = json.load(open(f"{OUT}/refs.json"))

def run(*a, cwd=None):
    p = subprocess.run(list(a), capture_output=True, text=True, cwd=cwd)
    return p.returncode, p.stdout.strip()

def has(repo, oid):
    return run("git", "-C", repo, "cat-file", "-e", oid + "^{commit}")[0] == 0

def prview(slug, n):
    rc, o = run("gh", "pr", "view", str(n), "--repo", slug, "--json", "number,state,headRefOid,mergeCommit,headRefName,title,url")
    return json.loads(o) if rc == 0 else None

def issue(slug, n):
    rc, o = run("gh", "issue", "view", str(n), "--repo", slug, "--json", "number,state,title,url,stateReason")
    if rc != 0: return None
    d = json.loads(o)
    rc, o = run("gh", "pr", "list", "--repo", slug, "--state", "all", "--search", f"{n} in:title,body", "--json", "number,state,title,headRefName", "--limit", "10")
    d["related_prs"] = json.loads(o) if rc == 0 else []
    return d

def work(item):
    repo = os.path.join(BASE, item["repo"])
    tip = item["sha"]
    slug = item["slug"]
    out = {}
    prs = item.get("prs") if isinstance(item.get("prs"), list) else []
    for p in prs:
        v = prview(slug, p["number"])
        if not v: continue
        h = v["headRefOid"]
        if not has(repo, h):
            run("git", "-C", repo, "fetch", "-q", "origin", f"refs/pull/{p['number']}/head")
        rel = "unknown"
        if has(repo, h):
            if h == tip: rel = "tip==prhead"
            elif run("git", "-C", repo, "merge-base", "--is-ancestor", tip, h)[0] == 0: rel = "tip-ancestor-of-prhead"
            else:
                rc, extra = run("git", "-C", repo, "rev-list", "--count", f"{h}..{tip}")
                rel = f"tip-has-{extra}-commits-beyond-prhead"
                if item.get("default"):
                    _, ch = run("git", "-C", repo, "cherry", item["default"], tip, h)
                    rel += f" (cherry-unique-vs-default:{sum(1 for l in ch.splitlines() if l.startswith('+'))})"
                    _, dd = run("git", "-C", repo, "diff", "--stat", h, tip)
                    rel += " diffstat:" + (dd.splitlines()[-1] if dd else "none")
        out.setdefault("pr_checks", []).append({"n": p["number"], "state": v["state"], "rel": rel, "issues": []})
    n = item.get("number_hint")
    if n and slug and (item.get("ahead") or item.get("dirty")) and not any(pc["state"] == "MERGED" and pc["rel"].startswith("tip") and "beyond" not in pc["rel"] for pc in out.get("pr_checks", [])):
        out["issue"] = issue(slug, n)
    return out

items = [it for r in res for it in r["items"]]
todo = [it for it in items if (it.get("ahead") or it.get("dirty") or it.get("prs")) and it.get("slug")]
with ThreadPoolExecutor(6) as ex:
    outs = list(ex.map(work, todo))
for it, o in zip(todo, outs): it.update(o)
json.dump(res, open(f"{OUT}/refs.json", "w"), indent=1)
print(len(todo))
