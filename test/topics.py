
import json, subprocess, urllib.request
proc = subprocess.run(["git","credential","fill"], input="protocol=https\nhost=github.com\n\n", capture_output=True, text=True, cwd=r"E:\Workspace\st-ledger", timeout=45)
tok = ""
for line in proc.stdout.splitlines():
    if line.startswith("password="): tok = line.split("=",1)[1].strip()
req = urllib.request.Request("https://api.github.com/repos/HakaiGod420/st-ledger/topics",
    method="PUT",
    data=json.dumps({"names": ["sillytavern","sillytavern-extension","roleplay","llm","ui"]}).encode(),
    headers={"Authorization":"Bearer "+tok,"Accept":"application/vnd.github+json","User-Agent":"ledger","Content-Type":"application/json"})
with urllib.request.urlopen(req) as r:
    print(r.status, json.loads(r.read().decode())["names"])
