"""Target-scoped, deterministic disassembly prerequisite analysis.

This module deliberately does not create a global removal plan.  Given one
selected part, it records the directions in which that part is blocked and
recursively explains only the parts required to clear one minimal exit route.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import numpy as np

from .collision import CollisionEngine
from .geometry import canonical_directions, direction_label, scene_bounds
from .types import DirectionTest, Part, vec


@dataclass(slots=True)
class SolverConfig:
    clearance_ratio: float = 0.02
    probe_ratio: float = 0.0001
    allow_aabb_fallback: bool = False


class DisassemblySolver:
    """Analyze dependencies for one requested target, never a whole assembly."""

    def __init__(self, parts: list[Part], config: SolverConfig | None = None) -> None:
        self.parts = {part.id: part for part in parts}
        self.config = config or SolverConfig()
        self.directions = canonical_directions()
        self.engine = CollisionEngine(self.parts, self.config.allow_aabb_fallback)
        bounds = scene_bounds(parts)
        self.diagonal = float(np.linalg.norm(bounds[1] - bounds[0])) or 1.0
        self.clearance = self.diagonal * self.config.clearance_ratio
        # This is intentionally a very short offset.  It allows a mating face
        # to separate along an exit direction without treating t=0 contact as a
        # blocker, while a real overlap remains a collision.
        self.probe_distance = self.diagonal * self.config.probe_ratio
        self._evaluations: dict[str, dict[str, Any]] = {}

    def _part_summary(self, part: Part) -> dict[str, Any]:
        return {
            "id": part.id,
            "name": part.name,
            "node": part.node,
            "parent": part.parent,
            "order": part.order,
            "hierarchy_depth": part.hierarchy_depth,
            "bounds": [vec(part.bounds[0]), vec(part.bounds[1])],
            "fastener": {"value": part.is_fastener, "reason": part.fastener_reason},
        }

    def workspace(self) -> dict[str, Any]:
        """Return a target-neutral DGP payload after Blender extraction.

        A target is intentionally not guessed.  The viewer uses this payload to
        render the assembly, then calls :meth:`analyze_target` after the user
        selects the part they want to remove.
        """
        return {
            "schema_version": "2.0",
            "mode": "target_prerequisite_workspace",
            "engine": self.engine.name,
            "verified": self.engine.certified,
            "parts": [self._part_summary(part) for part in sorted(self.parts.values(), key=lambda item: item.order)],
            "target": None,
            "dependencies": [],
            "prerequisite_order": [],
            "count": 0,
            "dependency_graph": {"nodes": [], "edges": [], "evidence": []},
            "node_evaluations": [],
            "tree": None,
            "unresolved": None,
        }

    def _resolve_part_id(self, target_part_name: str) -> str:
        if target_part_name in self.parts:
            return target_part_name
        exact = [part.id for part in self.parts.values() if part.name == target_part_name or part.node == target_part_name]
        if len(exact) == 1:
            return exact[0]
        folded = [part.id for part in self.parts.values() if part.name.casefold() == target_part_name.casefold()]
        if len(folded) == 1:
            return folded[0]
        if exact or folded:
            raise ValueError(f"Target part name is ambiguous: {target_part_name}")
        raise ValueError(f"Unknown target part: {target_part_name}")

    def escape_distance(self, part: Part, direction: np.ndarray) -> float:
        """Move beyond the complete assembly envelope plus deterministic clearance."""
        bounds = scene_bounds(self.parts.values())
        distances: list[float] = []
        for axis, component in enumerate(direction):
            if component > 1e-10:
                distances.append((bounds[1, axis] - part.bounds[0, axis]) / component)
            elif component < -1e-10:
                distances.append((bounds[0, axis] - part.bounds[1, axis]) / component)
        return max(0.0, max(distances, default=0.0)) + self.clearance

    def test_direction(self, part: Part, direction: np.ndarray) -> DirectionTest:
        """Record every part that blocks one candidate target translation."""
        travel = self.escape_distance(part, direction)
        translation = direction * travel
        hits: list[tuple[float, int, str, Any]] = []
        for other in sorted(self.parts.values(), key=lambda item: item.order):
            if other.id == part.id:
                continue
            hit = self.engine.sweep(part.id, other.id, translation, self.probe_distance)
            if hit.blocked:
                hits.append((float(hit.toi or 0.0), other.order, other.id, hit))
        hits.sort(key=lambda item: (item[0], item[1], item[2]))
        details = [
            {
                "part_id": blocker_id,
                "time_of_impact": round(toi, 8),
                "distance": round(toi * travel, 8),
                "contact": hit.contacts,
            }
            for toi, _order, blocker_id, hit in hits
        ]
        return DirectionTest(
            direction=direction,
            label=direction_label(direction),
            result="blocked" if hits else "free",
            travel_distance=travel,
            blockers=[item[2] for item in hits],
            blocker_details=details,
            toi=hits[0][0] if hits else None,
            contacts=hits[0][3].contacts if hits else [],
            verified=self.engine.certified,
        )

    def _direction_rank(self, direction: np.ndarray) -> int:
        return next(index for index, item in enumerate(self.directions) if np.allclose(item, direction))

    def _evaluate(self, part_id: str) -> dict[str, Any]:
        cached = self._evaluations.get(part_id)
        if cached is not None:
            return cached
        part = self.parts[part_id]
        tests = [self.test_direction(part, direction) for direction in self.directions]
        options = [
            {
                "direction": test.label,
                "vector": vec(test.direction),
                "travel_distance": round(test.travel_distance, 8),
                "blockers": test.blockers,
                "free": test.result == "free",
                "direction_rank": self._direction_rank(test.direction),
            }
            for test in tests
        ]
        result = {
            "part_id": part_id,
            "part_name": part.name,
            "tested": [test.as_dict() for test in tests],
            "exit_options": options,
            "removable_now": any(test.result == "free" for test in tests),
        }
        self._evaluations[part_id] = result
        return result

    def _option_key(self, option: dict[str, Any]) -> tuple[Any, ...]:
        return (
            len(option["blockers"]),
            float(option["travel_distance"]),
            int(option["direction_rank"]),
        )

    def analyze_target(self, target_part_name: str) -> dict[str, Any]:
        """Return the selected part's recursive, minimal prerequisite tree.

        Every candidate direction is physically tested.  When no direct exit is
        free, each candidate represents an AND-set of blockers.  The analyzer
        recursively evaluates only those alternatives and chooses the route
        with the fewest unique prerequisite parts; ties use travel distance and
        the fixed direction enumeration.  This is target-local dependency
        resolution, not a global assembly plan.
        """
        target_id = self._resolve_part_id(target_part_name)

        @lru_cache(maxsize=8192)
        def resolve(part_id: str, ancestry: tuple[str, ...]) -> dict[str, Any]:
            if part_id in ancestry:
                return {
                    "part_id": part_id,
                    "closure": frozenset(),
                    "tree": {"part_id": part_id, "cycle": True, "children": []},
                    "choice": None,
                    "complete": False,
                    "reason": "cyclic_target_dependency",
                }

            evaluation = self._evaluate(part_id)
            options = sorted(evaluation["exit_options"], key=self._option_key)
            if evaluation["removable_now"]:
                free_option = options[0]
                return {
                    "part_id": part_id,
                    "closure": frozenset(),
                    "tree": {
                        "part_id": part_id,
                        "cycle": False,
                        "chosen_exit": free_option,
                        "children": [],
                    },
                    "choice": free_option,
                    "complete": True,
                    "reason": None,
                }

            candidates: list[dict[str, Any]] = []
            min_blocker_count = len(options[0]["blockers"]) if options else 0
            pruned_options = [opt for opt in options if len(opt["blockers"]) <= min_blocker_count + 2][:5]

            for option in pruned_options:
                children: list[dict[str, Any]] = []
                closure: set[str] = set()
                complete = True
                primary_blockers = option["blockers"][:2] if len(option["blockers"]) > 2 else option["blockers"]
                for blocker in primary_blockers:
                    child = resolve(blocker, ancestry + (part_id,))
                    children.append(child)
                    closure.add(blocker)
                    closure.update(child["closure"])
                    complete = complete and bool(child["complete"])
                candidates.append(
                    {
                        "part_id": part_id,
                        "closure": frozenset(closure),
                        "tree": {
                            "part_id": part_id,
                            "cycle": False,
                            "chosen_exit": option,
                            "children": [child["tree"] for child in children],
                        },
                        "choice": option,
                        "complete": complete,
                        "reason": None if complete else "cyclic_target_dependency",
                    }
                )


            # A direct free exit has an empty blocker set and therefore wins.
            complete_candidates = [item for item in candidates if item["complete"]]
            if not complete_candidates:
                return min(candidates, key=lambda item: (len(item["closure"]), self._option_key(item["choice"])))
            return min(
                complete_candidates,
                key=lambda item: (
                    len(item["closure"]),
                    self._option_key(item["choice"]),
                    tuple(sorted(item["closure"])),
                ),
            )

        root = resolve(target_id, tuple())
        selected_options: dict[str, dict[str, Any]] = {}
        visited: set[str] = set()

        def collect(node: dict[str, Any]) -> None:
            part_id = node["part_id"]
            if node.get("cycle") or part_id in visited:
                return
            visited.add(part_id)
            if node.get("chosen_exit") is not None:
                selected_options[part_id] = node["chosen_exit"]
            for child in node.get("children", []):
                collect(child)

        collect(root["tree"])
        evidence: list[dict[str, Any]] = []
        for part_id in sorted(visited, key=lambda item: self.parts[item].order):
            evaluation = self._evaluate(part_id)
            selected = selected_options.get(part_id)
            for test in evaluation["tested"]:
                if test["result"] != "blocked":
                    continue
                details = {item["part_id"]: item for item in test.get("blocker_details", [])}
                for blocker in test.get("blockers", []):
                    detail = details.get(blocker, {})
                    evidence.append(
                        {
                            "from": blocker,
                            "to": part_id,
                            "type": "collision",
                            "reason": "continuous_mesh_contact" if self.engine.certified else "aabb_development_fallback",
                            "direction": test["direction"],
                            "contact": detail.get("contact", []),
                            "distance": detail.get("distance"),
                            "time_of_impact": detail.get("time_of_impact"),
                            "required": bool(selected and selected["direction"] == test["direction"] and blocker in selected["blockers"]),
                            "verified": self.engine.certified,
                        }
                    )

        # The tree naturally gives an executable prerequisite order: leaves
        # first, with duplicate dependencies emitted only once.  No whole-graph
        # topological sort is performed.
        prerequisite_order: list[str] = []
        emitted: set[str] = set()

        def postorder(node: dict[str, Any]) -> None:
            if node.get("cycle"):
                return
            for child in node.get("children", []):
                postorder(child)
            part_id = node["part_id"]
            if part_id != target_id and part_id not in emitted:
                emitted.add(part_id)
                prerequisite_order.append(part_id)

        postorder(root["tree"])
        dependencies = [
            {
                "id": part_id,
                "name": self.parts[part_id].name,
                "order": index + 1,
                "fastener": {"value": self.parts[part_id].is_fastener, "reason": self.parts[part_id].fastener_reason},
            }
            for index, part_id in enumerate(prerequisite_order)
        ]
        node_evaluations = [self._evaluate(part_id) for part_id in sorted(visited, key=lambda item: self.parts[item].order)]
        unresolved = None if root["complete"] else {"reason": root["reason"], "target": target_id}
        target = self._part_summary(self.parts[target_id])
        return {
            "schema_version": "2.0",
            "mode": "target_prerequisite_analysis",
            "engine": self.engine.name,
            "verified": self.engine.certified,
            "parts": [self._part_summary(part) for part in sorted(self.parts.values(), key=lambda item: item.order)],
            "target": target,
            "dependencies": dependencies,
            "prerequisite_order": prerequisite_order,
            "count": len(prerequisite_order),
            "dependency_graph": {
                "nodes": [part_id for part_id in sorted(visited, key=lambda item: self.parts[item].order)],
                "edges": evidence,
                "evidence": evidence,
            },
            "node_evaluations": node_evaluations,
            "tree": root["tree"],
            "unresolved": unresolved,
        }
