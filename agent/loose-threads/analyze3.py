import json, os, subprocess
from concurrent.futures import ThreadPoolExecutor

def run(*a, cwd=None):
    p = subprocess.run(list(a), capture_output=True, text=True, cwd=cwd)
    return p.returncode, p.stdout.strip()
def has(repo, oid):
    return run("git", "-C", repo, "cat-file", "-e", oid + "^{commit}")[0] == 0
def prview(slug, n):
    rc, o = run("gh", "pr", "view", str(n), "--repo", slug, "--json", "number,state,headRefOid,headRefName,title,url")
    return json.loads(o) if rc == 0 else None
OUT=os.environ["LT_OUT"]; BASE="/Volumes/sourcecode/repos"
res=json.load(open(f"{OUT}/refs.json"))
def proven(it): return any(p["state"]=="MERGED" and (p["rel"].startswith("tip==") or p["rel"].startswith("tip-anc") or "cherry-unique-vs-default:0" in p["rel"]) for p in it.get("pr_checks",[]))
def work(it):
    repo=os.path.join(BASE,it["repo"]); tip=it["sha"]; slug=it["slug"]
    cands=set()
    if it.get("issue"):
        iss=it["issue"]
        if iss["state"] in("MERGED",) or (it["branch"] or "").startswith("pr"): cands.add(iss["number"])
        for p in iss.get("related_prs",[]): cands.add(p["number"])
    done={p["n"] for p in it.get("pr_checks",[])}
    out=[]
    for n in sorted(cands-done):
        v=prview(slug,n)
        if not v: continue
        h=v["headRefOid"]
        if not has(repo,h): run("git","-C",repo,"fetch","-q","origin",f"refs/pull/{n}/head")
        rel="unknown"
        if has(repo,h):
            if h==tip: rel="tip==prhead"
            elif run("git","-C",repo,"merge-base","--is-ancestor",tip,h)[0]==0: rel="tip-ancestor-of-prhead"
            else:
                _,extra=run("git","-C",repo,"rev-list","--count",f"{h}..{tip}")
                _,ch=run("git","-C",repo,"cherry",it["default"],tip,h)
                # also patch-id vs PR head itself (rebased copies)
                _,ch2=run("git","-C",repo,"cherry",h,tip)
                rel=f"tip-has-{extra}-beyond-prhead (unique-vs-default:{sum(l.startswith('+') for l in ch.splitlines())}, unique-vs-prhead:{sum(l.startswith('+') for l in ch2.splitlines())})"
        out.append({"n":n,"state":v["state"],"rel":rel,"issues":[],"via":"related","head":v["headRefName"]})
    return out
todo=[it for r in res for it in r["items"] if it.get("slug") and it.get("ahead") and not proven(it)]
with ThreadPoolExecutor(6) as ex: outs=list(ex.map(work,todo))
for it,o in zip(todo,outs): it.setdefault("pr_checks",[]).extend(o)
json.dump(res,open(f"{OUT}/refs.json","w"),indent=1); print(len(todo))
