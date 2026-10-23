import json
import os
import pathlib
import shutil
import subprocess
import time
import urllib.request

TARGET = os.environ["LAB_TARGET_URL"]
TASK = os.environ["LAB_TASK"]
shutil.copy("/app/artex", "/tmp/artex")
p = subprocess.Popen(
    ["/tmp/artex", "-addr", "127.0.0.1:8787", "-proxy", "127.0.0.1:8788", "-data", "/tmp/data"],
    stdout=open("/tmp/artex.log", "w"), stderr=subprocess.STDOUT)


def call(path, body=None, token=""):
    req = urllib.request.Request(
        "http://127.0.0.1:8787" + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.load(res)


try:
    for _ in range(120):
        try:
            call("/api/health")
            break
        except Exception:
            if p.poll() is not None:
                raise RuntimeError(pathlib.Path("/tmp/artex.log").read_text()[-2000:])
            time.sleep(0.5)
    else:raise RuntimeError("ARTEX backend readiness failed")
    auth = call("/api/auth/init", {"password": "LabOnly-Autonomy-2846!"})
    token = auth["token"]
    created = call("/api/tasks", {
        "name": "Authorized assessment",
        "description": TASK,
        "goal": "Report confirmed security issues with evidence.",
        "seed_first_intent": False,
        "timeout_seconds": 480,
    }, token)
    print("CREATED", json.dumps(created), flush=True)
    for _ in range(120):
        time.sleep(5)
        status = call("/api/tasks/" + created["id"], token=token)
        pathlib.Path("/tmp/resource-snapshot.json").write_text(json.dumps(status,ensure_ascii=False))
        print("STATUS", json.dumps(status, ensure_ascii=False), flush=True)
        if status.get("status") in ("completed", "failed", "timeout", "stopped"):
            if status.get("status") != "completed":raise RuntimeError("ARTEX task ended: "+str(status.get("status")))
            break
finally:
    p.terminate()
    print(pathlib.Path("/tmp/artex.log").read_text()[-16000:], flush=True)
