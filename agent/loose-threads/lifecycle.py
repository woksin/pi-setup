import json,subprocess,os
L=os.path.expanduser("~/.local/share/ai-work-lifecycle/ai-work-lifecycle.py")
rows=[]
repos=[l.strip()[2:] for l in open(os.environ["LT_OUT"]+"/repos.txt")]
for r in repos:
    p="/Volumes/sourcecode/repos/"+r
    if not os.path.isdir(p+"/.ai-work"): continue
    o=subprocess.run(["python3",L,"--repo",p,"unfinished"],capture_output=True,text=True)
    try: d=json.loads(o.stdout)
    except Exception: 
        if o.stdout.strip() or o.stderr.strip(): rows.append((r,"?","ERR",0,"",o.stderr.strip()[:150]))
        continue
    for t in d.get("unfinished",[]):
        f=subprocess.run(["python3",L,"--repo",p,"finish",t["task"]],capture_output=True,text=True)
        txt=(f.stdout+f.stderr).strip()
        try:
            fj=json.loads(f.stdout); summ=json.dumps({k:fj[k] for k in fj if k in("status","refusals","reason","bytes","would_remove","blocked","errors","result","decision")})[:300]
        except Exception: summ=txt.replace("\n"," ")[:300]
        alive=subprocess.run(["kill","-0",str(t.get("owner_pid",0))],capture_output=True).returncode==0 if t.get("owner_pid") else False
        td=p+"/.ai-work/tasks/"+t["task"]
        sz=subprocess.run(["du","-sk",td],capture_output=True,text=True).stdout.split("\t")[0] if os.path.isdir(td) else "MISSING"
        rows.append((r,t["task"],t["state"],round(t["age_seconds"]/86400,1),f"pid={t.get('owner_pid')} alive={alive}",f"taskdirKB={sz} | finish-preview: {summ}"))
with open(os.environ["LT_OUT"]+"/lifecycle.tsv","w") as fh:
    for x in rows: fh.write("\t".join(map(str,x))+"\n")
print(len(rows))
