"""独立非思考兼容实验，不恢复或伪造内部工具调用的推理内容。"""
import copy
from budget_extended import Budget as ThinkingBudget

class Budget(ThinkingBudget):
    def restore_reasoning(self, body):
        request=copy.deepcopy(body)
        request['thinking']={'type':'disabled'}
        return request,[]
