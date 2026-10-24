#!/usr/bin/env python3
"""复用既有 BoxPwnr 控制器，预算终止时先落盘其 finally 中的工具轨迹。"""
from pathlib import Path
import runpy
import signal


def terminate(signum, _frame):
    raise SystemExit(128+signum)


signal.signal(signal.SIGTERM, terminate)
runpy.run_path(str(Path(__file__).with_name('boxpwnr_controller.py')), run_name='__main__')
