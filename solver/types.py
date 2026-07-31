"""Shared, JSON-friendly types for the deterministic planner."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np


def vec(value: np.ndarray | list[float] | tuple[float, ...]) -> list[float]:
    return [round(float(component), 8) for component in value]


@dataclass(slots=True)
class Part:
    id: str
    name: str
    node: str
    order: int
    parent: str | None
    hierarchy_depth: int
    mesh: Any
    bounds: np.ndarray
    is_fastener: bool
    fastener_reason: str | None = None

    @property
    def center(self) -> np.ndarray:
        return (self.bounds[0] + self.bounds[1]) / 2

    @property
    def extent(self) -> np.ndarray:
        return self.bounds[1] - self.bounds[0]


@dataclass(slots=True)
class CollisionHit:
    blocked: bool
    blocker_id: str | None = None
    toi: float | None = None
    contacts: list[dict[str, list[float]]] = field(default_factory=list)
    engine: str = "fcl_continuous"


@dataclass(slots=True)
class DirectionTest:
    direction: np.ndarray
    label: str
    result: str
    travel_distance: float
    blockers: list[str] = field(default_factory=list)
    blocker_details: list[dict[str, Any]] = field(default_factory=list)
    toi: float | None = None
    contacts: list[dict[str, list[float]]] = field(default_factory=list)
    verified: bool = False

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "direction": self.label,
            "vector": vec(self.direction),
            "result": self.result,
            "travel_distance": round(self.travel_distance, 8),
            "verified": self.verified,
        }
        if self.blockers:
            payload["by"] = self.blockers[0]
            payload["blockers"] = self.blockers
        if self.blocker_details:
            payload["blocker_details"] = self.blocker_details
        if self.toi is not None:
            payload["time_of_impact"] = round(self.toi, 8)
            payload["distance"] = round(self.travel_distance * self.toi, 8)
        if self.contacts:
            payload["contact"] = self.contacts
        return payload


@dataclass(slots=True)
class AccessibilityResult:
    accessible: bool
    approach_direction: np.ndarray | None
    approach_label: str | None
    blockers: list[str]
    tests: list[dict[str, Any]]
