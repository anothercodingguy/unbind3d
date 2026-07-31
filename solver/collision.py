"""Continuous collision checks with an explicit development-only fallback."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .geometry import aabb_intersects, swept_aabb
from .types import CollisionHit, Part, vec


@dataclass(slots=True)
class CollisionEngine:
    parts: dict[str, Part]
    allow_aabb_fallback: bool = False
    _fcl: Any | None = field(default=None, init=False, repr=False)
    _models: dict[str, Any] = field(default_factory=dict, init=False, repr=False)

    def __post_init__(self) -> None:
        try:
            import fcl  # type: ignore

            self._fcl = fcl
            for part in self.parts.values():
                vertices = np.asarray(part.mesh.vertices, dtype=np.float64)
                faces = np.asarray(part.mesh.faces, dtype=np.int32)
                model = fcl.BVHModel()
                model.beginModel(len(vertices), len(faces))
                model.addSubModel(vertices, faces)
                model.endModel()
                self._models[part.id] = model
        except ImportError:
            if not self.allow_aabb_fallback:
                raise RuntimeError(
                    "python-fcl is required for certified planning. Install requirements.txt "
                    "or pass --allow-aabb-fallback only for development."
                )

    @property
    def certified(self) -> bool:
        return self._fcl is not None

    @property
    def name(self) -> str:
        return "fcl_continuous" if self.certified else "aabb_fallback"

    def _object(self, part_id: str, translation: np.ndarray | None = None) -> Any:
        assert self._fcl is not None
        transform = self._fcl.Transform(np.asarray(translation, dtype=float)) if translation is not None else self._fcl.Transform()
        return self._fcl.CollisionObject(self._models[part_id], transform)

    def _contacts(self, moving_id: str, static_id: str, translation: np.ndarray) -> list[dict[str, list[float]]]:
        if not self.certified:
            return []
        assert self._fcl is not None
        request = self._fcl.CollisionRequest(num_max_contacts=3, enable_contact=True)
        result = self._fcl.CollisionResult()
        self._fcl.collide(self._object(moving_id, translation), self._object(static_id), request, result)
        contacts: list[dict[str, list[float]]] = []
        for contact in getattr(result, "contacts", []):
            contacts.append({"point": vec(np.asarray(contact.pos)), "normal": vec(np.asarray(contact.normal))})
        return contacts

    def sweep(self, moving_id: str, static_id: str, translation: np.ndarray, probe_distance: float) -> CollisionHit:
        moving = self.parts[moving_id]
        static = self.parts[static_id]
        if not aabb_intersects(swept_aabb(moving.bounds, translation), static.bounds):
            return CollisionHit(blocked=False, engine=self.name)

        if not self.certified:
            # Conservative development fallback. It deliberately labels its
            # results as unverified instead of pretending to be mesh-accurate.
            return CollisionHit(blocked=True, blocker_id=static_id, toi=0.5, engine=self.name)

        assert self._fcl is not None
        start = np.zeros(3)
        # Exact CAD meshes often touch at t=0. A short separating probe prevents
        # an allowed face contact from being reported as a blocking intersection.
        start_offset = min(probe_distance, float(np.linalg.norm(translation)) * 0.01)
        if start_offset > 0:
            direction = translation / np.linalg.norm(translation)
            probe = direction * start_offset
            request = self._fcl.CollisionRequest(num_max_contacts=1, enable_contact=False)
            result = self._fcl.CollisionResult()
            if self._fcl.collide(self._object(moving_id, probe), self._object(static_id), request, result) == 0:
                start = probe

        # FCL's conservative-advancement path does not reliably support two
        # arbitrary BVH triangle meshes on all supported builds. Its native
        # translation CCD mode does, so use the high-resolution deterministic
        # naive CCD solver for CAD mesh pairs.
        positive_extents = np.concatenate([moving.extent[moving.extent > 1e-8], static.extent[static.extent > 1e-8]])
        smallest_feature = float(positive_extents.min()) if len(positive_extents) else probe_distance
        # Keep each CCD substep below one quarter of the smallest object extent.
        # This is deterministic and much faster than a fixed 2,000-step budget
        # on large CAD scenes, while retaining additional resolution for screws.
        num_iterations = int(np.clip(np.ceil(np.linalg.norm(translation) / max(smallest_feature * 0.5, probe_distance * 10)), 16, 64))

        request = self._fcl.ContinuousCollisionRequest(
            num_max_iterations=num_iterations,
            toc_err=1e-6,
            ccd_motion_type=self._fcl.CCDMotionType.CCDM_TRANS,
            ccd_solver_type=self._fcl.CCDSolverType.CCDC_NAIVE,
        )
        result = self._fcl.ContinuousCollisionResult()
        toi = float(
            self._fcl.continuousCollide(
                self._object(moving_id, start),
                self._fcl.Transform(np.asarray(translation, dtype=float)),
                self._object(static_id),
                self._fcl.Transform(),
                request,
                result,
            )
        )
        if toi >= 1.0 - 1e-9:
            return CollisionHit(blocked=False, engine=self.name)
        full_toi = (start_offset / max(np.linalg.norm(translation), 1e-12)) + toi * (1 - start_offset / max(np.linalg.norm(translation), 1e-12))
        contact_translation = translation * min(max(full_toi, 0.0), 1.0)
        return CollisionHit(
            blocked=True,
            blocker_id=static_id,
            toi=full_toi,
            contacts=self._contacts(moving_id, static_id, contact_translation),
            engine=self.name,
        )
