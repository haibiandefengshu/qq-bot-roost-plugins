"""插件基类垫片：满足导入路径，不参与实际运行。"""


class Context:  # pragma: no cover - 仅占位
    """占位上下文。"""


class Star:  # pragma: no cover - 仅占位
    """占位插件基类。"""

    def __init__(self, context=None) -> None:
        self.context = context


def register(*args, **kwargs):  # pragma: no cover - 仅占位
    """占位注册装饰器。"""

    def decorator(cls):
        return cls

    return decorator


__all__ = ["Context", "Star", "register"]
