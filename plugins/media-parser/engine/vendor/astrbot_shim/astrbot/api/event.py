"""事件类型垫片：上游 sender.py 仅在导入期引用 AstrMessageEvent。"""


class AstrMessageEvent:  # pragma: no cover - 仅占位
    """占位类，QQ 适配层不经过 AstrBot 事件模型。"""


class _FilterNamespace:
    """占位装饰器集合，正常路径不会被调用。"""

    def __getattr__(self, name):  # pragma: no cover
        def decorator(*args, **kwargs):
            def wrapper(func):
                return func

            return wrapper

        return decorator


filter = _FilterNamespace()

__all__ = ["AstrMessageEvent", "filter"]
