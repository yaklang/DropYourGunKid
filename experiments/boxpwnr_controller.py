"""BoxPwnr 原生 XML solver；模型命令仅进入受限容器。"""
import os, sys, json, pathlib, threading, importlib.util
root=pathlib.Path(os.environ.get('DYGK_RESEARCH_ROOT','/home/Kei/ai-pentest-countermeasures'))
sys.path.insert(0,str(root/'scripts'))
import run_db_autonomy as box
from resource_budget_v4 import ResourceRelay
for key in ('ALL_PROXY','all_proxy','HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy'):
    os.environ.pop(key,None)
os.environ['NO_PROXY']='127.0.0.1,localhost'
container,out=sys.argv[1],pathlib.Path(sys.argv[2])
os.environ['DECOY_EVAL_ROOT']=str(root/'private/boxpwnr-model-compare')
spec=importlib.util.spec_from_file_location('resource_ev',root/'validation/ssh-decoy/evaluate.py')
ev=importlib.util.module_from_spec(spec);spec.loader.exec_module(ev)
trace=[]
relay=ResourceRelay(ev.load_provider('deepseek-official','deepseek-flash'),trace,out/'model.jsonl')
threading.Thread(target=relay.serve_forever,daemon=True).start()
def assess(ev, url, client, trace):
    """沿用框架提示与解析，不提供预先探测输出或安装指令。"""
    import yaml
    from jinja2 import Template
    from langchain_openai import ChatOpenAI
    from boxpwnr.core.llm_manager import LLMManager
    from boxpwnr.core.deadline import Deadline
    import boxpwnr.solvers.single_loop_xmltag as module

    class Manager(LLMManager):
        def initialize_chat_model(self):
            return ChatOpenAI(model=self.model_api_name, base_url=url,
                              api_key="lab-only", timeout=125, max_retries=0,
                              max_tokens=4096, profile={"max_input_tokens": 32768})

        def _extract_text_content(self, response):
            return box.normalize_dsml(super()._extract_text_content(response))

    module.LLMManager = Manager
    solver = module.SingleLoopXmltagSolver("ollama:/model", reasoning_effort="disabled")
    prompts = ev.LAB / "BoxPwnr/src/boxpwnr/prompts"
    generic = yaml.safe_load((prompts / "generic_prompt.yaml").read_text())["system_prompt"]
    native = yaml.safe_load((prompts / "solvers/single_loop_xmltag_prompt.yaml").read_text())["solver_prompt"]
    prompt = Template(generic).render(
        target_prompt=os.environ["LAB_TASK"],
        solver_prompt=Template(native).render(max_execution_timeout=8),
        user_additional_custom_instructions="")
    trace.append({"system_prompt": prompt})
    assert solver.initialize(prompt)
    solver.set_deadline(Deadline(max_seconds=480))
    for turn in range(1, 41):
        action = solver.get_next_action()
        trace.append({"turn": turn, "action_type": action.type, "content": action.content})
        if action.type != "command":
            return "agent_stopped"
        result = ev.execute(client, action.content)
        trace.append({"turn": turn, "execution": result})
        solver.handle_result(result)
    return "turn_budget"

try:
    status=assess(ev,f'http://127.0.0.1:{relay.server_port}/v1',container,trace)
    (out/'controller-result.json').write_text(json.dumps({'status':status}))
    print('SOLVER_STATUS',status,flush=True)
finally:
    (out/'solver-trace.json').write_text(json.dumps(trace,ensure_ascii=False,indent=2))
    relay.shutdown();relay.server_close()
