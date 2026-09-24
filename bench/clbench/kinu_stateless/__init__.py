"""The kinu system with nothing carried between instances: no auto-evolution, no persisted workspace.

The comparison arm for "does Kinu improve with use" (EVAL-5): run-all takes no system parameters, so the
stateless arm is its own registered system rather than a flag on ``kinu``.
"""

from typing import Any

from ...registry import register_system
from ..kinu.system import KinuSystem


@register_system("kinu_stateless")
class KinuStatelessSystem(KinuSystem):
    def __init__(self, **params: Any) -> None:
        super().__init__(**{"name": "kinu_stateless", "auto_evolve": False, "persist_workspace": False, **params})
