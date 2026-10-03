"""Application assembly and public-contract regression tests.

Fixtures were captured from the original app.main before the module split.
These checks never enter the application lifespan or initialize the live DB.
"""

from __future__ import annotations

import ast
from collections import Counter
from contextlib import ExitStack
import importlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.routing import APIWebSocketRoute
from starlette.routing import Match, Mount


ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = ROOT / "app"
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _read_fixture(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _iter_effective_routes(routes):
    """Flatten FastAPI's deferred included routers across supported versions."""
    for route in routes:
        effective_candidates = getattr(route, "effective_candidates", None)
        if effective_candidates is not None:
            yield from _iter_effective_routes(effective_candidates())
        else:
            yield route


def _route_inventory(app: FastAPI) -> list[dict]:
    routes = []
    for route in _iter_effective_routes(app.routes):
        original_route = getattr(route, "original_route", route)
        effective_route = getattr(route, "starlette_route", route)
        path = getattr(route, "path", None) or getattr(effective_route, "path", None)
        name = getattr(route, "name", None) or getattr(effective_route, "name", None)
        item = {"path": path, "name": name}
        if isinstance(original_route, APIWebSocketRoute):
            item.update(kind="websocket", methods=[])
        elif isinstance(original_route, Mount):
            item.update(kind="mount", methods=[])
        else:
            item.update(kind="http", methods=sorted(route.methods or []))
        routes.append(item)
    return routes


def _route_signature(route: dict) -> tuple:
    return route["kind"], route["path"], tuple(route["methods"]), route["name"]


def _first_difference(actual, expected, path: str = "$") -> str | None:
    """Keep a changed OpenAPI contract actionable without dumping 100 KB."""
    if type(actual) in {int, float} and type(expected) in {int, float} and actual == expected:
        return None  # JSON numbers have no separate integer/float identity.
    if type(actual) is not type(expected):
        return f"{path}: type {type(actual).__name__} != {type(expected).__name__}"
    if isinstance(expected, dict):
        missing = expected.keys() - actual.keys()
        added = actual.keys() - expected.keys()
        if missing or added:
            return f"{path}: missing keys={sorted(missing)!r}; added keys={sorted(added)!r}"
        for key in sorted(expected):
            difference = _first_difference(actual[key], expected[key], f"{path}.{key}")
            if difference:
                return difference
        return None
    if isinstance(expected, list):
        if len(actual) != len(expected):
            return f"{path}: length {len(actual)} != {len(expected)}"
        for index, (current, previous) in enumerate(zip(actual, expected)):
            difference = _first_difference(current, previous, f"{path}[{index}]")
            if difference:
                return difference
        return None
    if actual != expected:
        return f"{path}: {actual!r} != {expected!r}"
    return None


class ApplicationArchitectureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Importing an ASGI application must not start workers or initialize DB.
        cls.entrypoint = importlib.import_module("app.main")
        cls.app = cls.entrypoint.app

    def test_route_paths_methods_and_names_match_pre_split_contract(self):
        expected = _read_fixture("application_routes.json")
        self.assertEqual(
            sorted(map(_route_signature, _route_inventory(self.app))),
            sorted(map(_route_signature, expected)),
        )

    def test_openapi_parameters_models_and_responses_match_pre_split_contract(self):
        expected = _read_fixture("application_openapi.json")
        actual = self.app.openapi()
        # Site branding is configurable and is not an HTTP contract change.
        expected["info"]["title"] = actual["info"]["title"]
        difference = _first_difference(actual, expected)
        self.assertIsNone(difference, difference)

    def test_no_duplicate_http_or_websocket_routes(self):
        keys = []
        for route in _route_inventory(self.app):
            for method in route["methods"] or [route["kind"]]:
                keys.append((route["kind"], method, route["path"]))
        duplicates = [key for key, count in Counter(keys).items() if count > 1]
        self.assertEqual(duplicates, [])

    def test_literal_resource_routes_are_matched_before_dynamic_ids(self):
        for method, path, name in (
            ("GET", "/api/resources/ids", "list_resource_ids"),
            ("GET", "/api/resources/pick", "pick_resources"),
            ("GET", "/api/resources/pick-ids", "pick_resources_all_ids"),
            ("DELETE", "/api/resources/batch", "batch_delete_resources"),
        ):
            with self.subTest(method=method, path=path):
                scope = {"type": "http", "method": method, "path": path, "root_path": ""}
                matches = [
                    route
                    for route in _iter_effective_routes(self.app.routes)
                    if route.matches(scope)[0] == Match.FULL
                ]
                self.assertTrue(matches)
                self.assertEqual(matches[0].name, name)

    def test_spa_catch_all_is_registered_last(self):
        routes = _route_inventory(self.app)
        self.assertEqual(routes[-1]["path"], "/{full_path:path}")
        self.assertEqual(routes[-1]["name"], "spa_fallback")
        self.assertTrue(any(route["kind"] == "mount" and route["path"] == "/static" for route in routes[:-1]))

    def test_business_modules_do_not_import_application_entrypoint(self):
        violations = []
        for source in sorted(APP_ROOT.rglob("*.py")):
            if source == APP_ROOT / "main.py":
                continue
            tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
            for node in ast.walk(tree):
                reverse_import = False
                if isinstance(node, ast.Import):
                    reverse_import = any(alias.name == "app.main" or alias.name.startswith("app.main.") for alias in node.names)
                elif isinstance(node, ast.ImportFrom):
                    module = node.module or ""
                    reverse_import = (
                        module == "app.main"
                        or module.startswith("app.main.")
                        or module == "app" and any(alias.name == "main" for alias in node.names)
                        or node.level and module == "main"
                    )
                    if node.level and not module and any(alias.name == "main" for alias in node.names):
                        reverse_import = True
                elif isinstance(node, ast.Call) and node.args:
                    function_name = getattr(node.func, "attr", getattr(node.func, "id", ""))
                    reverse_import = (
                        function_name in {"import_module", "__import__"}
                        and isinstance(node.args[0], ast.Constant)
                        and node.args[0].value == "app.main"
                    )
                if reverse_import:
                    violations.append(f"{source.relative_to(ROOT)}:{node.lineno}")
        expected_legacy = {
            "app/core/download_tasks.py:431",
            "app/core/download_tasks.py:485",
            "app/core/download_tasks.py:560",
        }
        # The old monolith has these three imports; they are deliberately
        # asserted here until the download service migration removes them.
        if (APP_ROOT / "application.py").exists():
            self.assertEqual(violations, [], "Business code must import its owning service, not app.main")
        else:
            self.assertEqual(set(violations), expected_legacy)

    def test_main_is_only_an_application_entrypoint(self):
        source = (APP_ROOT / "main.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        if not (APP_ROOT / "application.py").exists():
            self.skipTest("entrypoint contract becomes enforceable after application.py migration")
        self.assertLessEqual(len(source.splitlines()), 60, "Do not move business logic back into the entrypoint")
        allowed = (ast.Import, ast.ImportFrom, ast.Assign, ast.AnnAssign)
        unexpected = [
            node for node in tree.body
            if not isinstance(node, allowed)
            and not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str))
        ]
        self.assertEqual(unexpected, [], "main.py should only import and call the application factory")
        self.assertIsInstance(self.entrypoint.app, FastAPI)

    def test_factory_creates_independent_apps_without_starting_services(self):
        if not (APP_ROOT / "application.py").exists():
            self.skipTest("factory is introduced by the application module migration")
        from app.application import create_app
        from app import lifecycle

        with ExitStack() as stack:
            db_init = stack.enter_context(patch("app.db.init_db", side_effect=AssertionError("Factory must not initialize live DB")))
            if hasattr(lifecycle, "init_db"):
                lifecycle_db_init = stack.enter_context(patch.object(lifecycle, "init_db", side_effect=AssertionError("Factory must not enter lifespan")))
            else:
                lifecycle_db_init = None
            first = create_app()
            second = create_app()
            db_init.assert_not_called()
            if lifecycle_db_init is not None:
                lifecycle_db_init.assert_not_called()
        self.assertIsInstance(first, FastAPI)
        self.assertIsNot(first, second)
        self.assertIsNot(first, self.app)
        self.assertIs(first.router.lifespan_context, lifecycle.lifespan)
        self.assertEqual(_route_inventory(first), _route_inventory(second))
        self.assertEqual(first.openapi(), second.openapi())


if __name__ == "__main__":
    unittest.main()
