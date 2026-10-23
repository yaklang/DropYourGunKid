"""ARTEX原生任务API与独立临时数据库；保持目标服务就绪检查。"""
import json,os,time,uuid
from pathlib import Path

def bind_runner(lab, images, root):
    def run_artex(out, condition, args):
        image = lab.build(images["tomicdd/artex:latest"], out.parent / (out.name + "-build"),
                          {"run.py": (root / "experiments/artex_controller.py").read_text()})
    
        class ArtexLab(lab.Lab):
            def prepare(self):
                super().prepare()
                name = "autonomy-artex-pg-" + uuid.uuid4().hex[:8]
                lab.docker("run", "-d", "--name", name, "--network", self.network_name,
                           "--network-alias", "artex-pg", "--user", "postgres",
                           "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only",
                           "--memory=512m", "--cpus=1", "--pids-limit=64",
                           "--tmpfs", "/tmp:rw,size=128m,mode=1777",
                           "--tmpfs", "/var/lib/postgresql/data:rw,size=128m,mode=1777",
                           "--tmpfs", "/var/run/postgresql:rw,size=8m,mode=1777",
                           "-e", "PGDATA=/tmp/pgdata", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
                           "-e", "POSTGRES_DB=artex", images["vxcontrol/pgvector:latest"])
                self.children.append(name)
                for _ in range(80):
                    if lab.docker("exec", name, "pg_isready", check=False).returncode == 0:
                        break
                    time.sleep(.5)
                else:
                    raise RuntimeError("postgres did not become ready")
                self.env["ARTEX_PG_DSN"] = "postgres://postgres@artex-pg:5432/artex?sslmode=disable"
    
        env = {
            "LAB_TARGET_URL": "http://target.lab:18092/",
            "LAB_TASK": args.task,
            "ARTEX_LLM_PROVIDER": "openai",
            "ARTEX_LLM_MODEL": args.model,
            "ARTEX_LLM_BASE_URL": "http://llm.lab:18093/v1",
            "OPENAI_API_KEY": "unused",
        }
        L = ArtexLab(out, "artex", image, ["/lab/run.py"], entry="python3", env=env,
                     seconds=args.seconds, task=args.task, source=args.source,
                     marker=args.marker, internal_network=True,
                     model=args.model, provider=args.provider,
                     model_call_limit=args.model_calls, model_timeout=args.model_timeout,
                     extra=["--tmpfs", "/app/data:rw,size=64m,mode=1777"])
        return L.run()
    
    return run_artex
