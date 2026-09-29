#!/usr/bin/env python3
"""Check installed distributions locally; never import application code or use a network.

Exit 0 means satisfied, 1 means installation is needed, and 2 means the
declarations/checker could not be evaluated safely. pip vendors packaging even
in a fresh venv, so checking does not require a bootstrap package installation.
"""
from __future__ import annotations

import argparse
from collections import defaultdict, deque
from importlib import metadata
from pathlib import Path
import re
import shlex
import sys

try:
    from packaging.markers import default_environment
    from packaging.requirements import InvalidRequirement, Requirement
    from packaging.specifiers import SpecifierSet
    from packaging.utils import canonicalize_name
    from packaging.version import InvalidVersion, Version
except ImportError:
    try:
        from pip._vendor.packaging.markers import default_environment
        from pip._vendor.packaging.requirements import InvalidRequirement, Requirement
        from pip._vendor.packaging.specifiers import SpecifierSet
        from pip._vendor.packaging.utils import canonicalize_name
        from pip._vendor.packaging.version import InvalidVersion, Version
    except ImportError:
        print("Dependency check unavailable: this interpreter needs pip or packaging.", file=sys.stderr)
        raise SystemExit(2)


class CheckError(Exception):
    pass


def read_requirements(paths):
    requirements = []
    constraints = defaultdict(list)

    def read(path, constraint=False, parents=()):
        path = Path(path).resolve()
        if path in parents:
            raise CheckError(f"Recursive requirements include: {path.name}")
        pending = ""
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.endswith("\\"):
                pending += line[:-1] + " "
                continue
            line = re.sub(r"\s+#.*$", "", pending + line).strip()
            pending = ""
            include = re.match(r"^(--requirement(?:=|\s+)|--constraint(?:=|\s+)|-r\s*|-c\s*)(.+)$", line)
            if include:
                filenames = shlex.split(include[2])
                if len(filenames) != 1 or "://" in filenames[0]:
                    raise CheckError(f"Expected one local include at {path.name}:{number}")
                is_constraint = constraint or include[1].startswith(("-c", "--constraint"))
                read(path.parent / filenames[0], is_constraint, (*parents, path))
                continue
            try:
                requirement = Requirement(line)
            except InvalidRequirement as exc:
                raise CheckError(f"Unsupported requirement at {path.name}:{number}") from exc
            if requirement.url or (constraint and requirement.extras):
                raise CheckError(f"Cannot verify this requirement locally at {path.name}:{number}")
            if constraint:
                constraints[canonicalize_name(requirement.name)].append(requirement)
            else:
                requirements.append(requirement)
        if pending:
            raise CheckError(f"Unfinished continuation in {path.name}")

    for path in paths:
        read(path)
    return requirements, constraints


def check_requirements(paths, get_distribution=metadata.distribution, environment=None):
    requirements, constraints = read_requirements(paths)
    environment = environment or default_environment()

    def applies(requirement, extras=("",)):
        return requirement.marker is None or any(
            requirement.marker.evaluate({**environment, "extra": extra}) for extra in extras
        )

    queue = deque(requirement for requirement in requirements if applies(requirement))
    distributions = {}
    expanded = {}
    seen = set()
    errors = []
    while queue:
        requirement = queue.popleft()
        if str(requirement) in seen:
            continue
        seen.add(str(requirement))
        name = canonicalize_name(requirement.name)
        if name not in distributions:
            try:
                distributions[name] = get_distribution(requirement.name)
            except metadata.PackageNotFoundError:
                distributions[name] = None
        distribution = distributions[name]
        if distribution is None:
            errors.append(f"{requirement.name}: not installed")
            continue
        try:
            version = Version(distribution.version)
        except (InvalidVersion, TypeError):
            errors.append(f"{requirement.name}: invalid installed version")
            continue
        for bound in [requirement, *constraints.get(name, [])]:
            if (bound is requirement or applies(bound)) and not bound.specifier.contains(version, prereleases=True):
                errors.append(f"{bound.name}{bound.specifier}: installed {version}")

        extras = {canonicalize_name(extra) for extra in requirement.extras}
        previous = expanded.get(name)
        if previous is not None and extras <= previous:
            continue
        extras |= previous or set()
        expanded[name] = extras
        declared_extras = {canonicalize_name(extra) for extra in distribution.metadata.get_all("Provides-Extra", [])}
        for extra in sorted(extras - declared_extras):
            errors.append(f"{requirement.name}: installed distribution does not provide extra {extra}")
        python_bound = distribution.metadata.get("Requires-Python")
        if python_bound and not SpecifierSet(python_bound).contains(environment["python_full_version"], prereleases=True):
            errors.append(f"{requirement.name}: requires Python {python_bound}")
        for raw_dependency in distribution.requires or []:
            try:
                dependency = Requirement(raw_dependency)
            except InvalidRequirement as exc:
                raise CheckError(f"Invalid dependency metadata for {requirement.name}") from exc
            if applies(dependency, {"", *extras}):
                if dependency.url:
                    raise CheckError(f"Cannot verify a direct URL dependency of {requirement.name} locally")
                queue.append(dependency)
    return list(dict.fromkeys(errors))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("requirements", nargs="+", type=Path)
    args = parser.parse_args()
    try:
        errors = check_requirements(args.requirements)
    except (CheckError, OSError, ValueError) as exc:
        print(f"Dependency check failed: {exc}", file=sys.stderr)
        return 2
    for error in errors[:20]:
        print(f"Dependency mismatch: {error}", file=sys.stderr)
    if len(errors) > 20:
        print(f"... and {len(errors) - 20} more mismatches", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
