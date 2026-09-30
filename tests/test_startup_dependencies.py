"""Exercise startup dependency checks without installing into the developer environment.

The shell tests run the actual dependency/build sections of run.sh in a temporary
project. Installers are controlled fixtures; npm ls is real and explicitly offline.
No server is started and no registry is contacted.
"""
from __future__ import annotations

import importlib.util
from importlib import metadata
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "tools/check_python_dependencies.py"
SPEC = importlib.util.spec_from_file_location("startup_dependency_checker", CHECKER)
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


def distribution(site, name, version, requires=(), extras=()):
    normalized = name.replace("-", "_")
    for existing in site.glob(f"{normalized}-*.dist-info"):
        shutil.rmtree(existing)
    target = site / f"{normalized}-{version}.dist-info"
    target.mkdir(parents=True)
    lines = ["Metadata-Version: 2.1", f"Name: {name}", f"Version: {version}"]
    lines.extend(f"Requires-Dist: {requirement}" for requirement in requires)
    lines.extend(f"Provides-Extra: {extra}" for extra in extras)
    (target / "METADATA").write_text("\n".join(lines) + "\n", encoding="utf-8")


class PythonDependencyCheckerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.site = self.root / "site"
        self.site.mkdir()
        self.requirements = self.root / "requirements.txt"

    def check(self, text):
        self.requirements.write_text(text, encoding="utf-8")
        installed = {
            checker.canonicalize_name(item.metadata["Name"]): item
            for item in metadata.distributions(path=[str(self.site)])
        }

        def lookup(name):
            try:
                return installed[checker.canonicalize_name(name)]
            except KeyError:
                raise metadata.PackageNotFoundError(name) from None

        return checker.check_requirements([self.requirements], get_distribution=lookup)

    def test_installed_distribution_versions_obey_both_bounds(self):
        for version, satisfied in [("1.9", False), ("2.5", True), ("3.0", False)]:
            with self.subTest(version=version):
                distribution(self.site, "fixture-core", version)
                errors = self.check("Fixture_Core>=2,<3\n")
                self.assertEqual(not errors, satisfied)

    def test_importable_module_does_not_replace_distribution_metadata(self):
        (self.site / "fixture_core.py").write_text("VALUE = 1\n")
        self.assertEqual(self.check("fixture-core>=2\n"), ["fixture-core: not installed"])

    def test_relative_includes_constraints_markers_and_comments(self):
        (self.root / "nested").mkdir()
        (self.root / "nested/base.txt").write_text("fixture-core>=1  # inline comment\n")
        (self.root / "limits.txt").write_text("fixture-core>=2,<3\nunused-package>=4\n")
        distribution(self.site, "fixture-core", "1.5")
        errors = self.check('-r nested/base.txt\n-c limits.txt\nskipped; python_version < "1"\n')
        self.assertEqual(errors, ["fixture-core<3,>=2: installed 1.5"])
        distribution(self.site, "fixture-core", "2.5")
        self.assertEqual(self.check('-r nested/base.txt\n-c limits.txt\nskipped; python_version < "1"\n'), [])

    def test_extras_validate_versions_and_recursive_extra_dependencies(self):
        distribution(self.site, "fixture-core", "2", ['fixture-child[tls]>=2; extra == "standard"'], ["standard"])
        distribution(self.site, "fixture-child", "1", ['fixture-tls>=3; extra == "tls"'], ["tls"])
        self.assertEqual(self.check("fixture-core>=2\n"), [])
        errors = self.check("fixture-core[standard]>=2\n")
        self.assertIn("fixture-child>=2: installed 1", errors)
        self.assertIn("fixture-tls: not installed", errors)
        distribution(self.site, "fixture-child", "2", ['fixture-tls>=3; extra == "tls"'], ["tls"])
        distribution(self.site, "fixture-tls", "3", ["fixture-core[standard]>=2"])
        self.assertEqual(self.check("fixture-core[standard]>=2\n"), [])

    def test_missing_transitive_dependency_is_detected(self):
        distribution(self.site, "fixture-core", "2", ["fixture-child>=1"])
        self.assertEqual(self.check("fixture-core>=2\n"), ["fixture-child: not installed"])

    def test_unsupported_declarations_and_include_cycles_fail_closed(self):
        for declaration in ["--unknown-option value\n", "fixture-core @ https://example.invalid/core.whl\n", "-r requirements.txt\n"]:
            with self.subTest(declaration=declaration):
                with self.assertRaises(checker.CheckError):
                    self.check(declaration)

    def test_checker_without_packaging_or_pip_reports_unavailable(self):
        self.requirements.write_text("fixture-core>=2\n")
        result = subprocess.run([sys.executable, "-S", str(CHECKER), str(self.requirements)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("needs pip or packaging", result.stderr)


INSTALLER_DRIVER = r'''
import json
import os
from pathlib import Path
import shutil
import sys

root = Path(os.environ["FIXTURE_ROOT"])
kind, *args = sys.argv[1:]
with (root / "commands.jsonl").open("a") as stream:
    stream.write(json.dumps({"kind": kind, "args": args}) + "\n")

def install_distribution(name, version):
    site = root / "site"
    normalized = name.replace("-", "_")
    for old in site.glob(normalized + "-*.dist-info"):
        shutil.rmtree(old)
    target = site / (normalized + "-" + version + ".dist-info")
    target.mkdir(parents=True)
    (target / "METADATA").write_text("Metadata-Version: 2.1\nName: " + name + "\nVersion: " + version + "\n")

if kind == "pip":
    behavior = os.environ.get("FAKE_PIP_BEHAVIOR", "install")
    if behavior == "damage":
        # Exit 0 so the post-install verification catches the damaged base env.
        for target in (root / "site").glob("sf_startup_core-*.dist-info"):
            shutil.rmtree(target)
        raise SystemExit(0)
    if behavior == "fail":
        raise SystemExit(9)
    if behavior == "incomplete":
        raise SystemExit(0)
    install_distribution("sf-startup-core", "2.5.0")
    install_distribution("sf-startup-worker", "2.1.0")
    raise SystemExit(0)

if args[0] == "ls":
    os.execv(os.environ["REAL_NPM"], [os.environ["REAL_NPM"], *args])
if args[:2] == ["run", "build"]:
    if os.environ.get("FAKE_BUILD_BEHAVIOR") == "fail":
        raise SystemExit(8)
    output = root / "app/static/dist/index.html"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("<html>built fixture</html>")
    raise SystemExit(0)
if args[0] not in ("ci", "install"):
    raise SystemExit(7)
behavior = os.environ.get("FAKE_NPM_BEHAVIOR", "install")
if behavior == "fail":
    raise SystemExit(9)
if behavior == "incomplete":
    raise SystemExit(0)
web = root / "web"
lock_path = web / "package-lock.json"
if lock_path.exists():
    lock = json.loads(lock_path.read_text())
else:
    pkg = json.loads((web / "package.json").read_text())
    packages = {"": pkg}
    for field in ("dependencies", "devDependencies"):
        for name, specifier in pkg.get(field, {}).items():
            packages["node_modules/" + name] = {"version": specifier.lstrip("^")}
    lock = {"name": pkg["name"], "version": pkg["version"], "lockfileVersion": 3, "packages": packages}
    lock_path.write_text(json.dumps(lock))
modules = web / "node_modules"
if modules.exists():
    shutil.rmtree(modules)
modules.mkdir()
for location, item in lock["packages"].items():
    if not location:
        continue
    package_dir = web / location
    package_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"name": location.rsplit("node_modules/", 1)[1], "version": item["version"]}
    for field in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bin"):
        if field in item:
            manifest[field] = item[field]
    (package_dir / "package.json").write_text(json.dumps(manifest))
    for name, target in item.get("bin", {}).items():
        script = package_dir / target
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text("#!/usr/bin/env node\n")
        bin_dir = web / location.rsplit("node_modules/", 1)[0] / "node_modules/.bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        (bin_dir / name).symlink_to(script)
hidden = {**lock, "packages": {key: value for key, value in lock["packages"].items() if key}}
(modules / ".package-lock.json").write_text(json.dumps(hidden))
'''


@unittest.skipUnless(shutil.which("node") and shutil.which("npm"), "Node and npm are required for the offline startup regression")
class StartupDependencyBehaviorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="slideflow-startup-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.site = self.root / "site"
        self.site.mkdir()
        (self.root / "tools").symlink_to(ROOT / "tools", target_is_directory=True)
        (self.root / "requirements.txt").write_text("sf-startup-core>=2,<3\nsf-startup-worker>=2,<3\n")
        for module in ("gunicorn", "uvicorn_worker"):
            (self.site / f"{module}.py").write_text("# isolated import smoke-test fixture\n")
        distribution(self.site, "sf-startup-core", "2.0.0")
        distribution(self.site, "sf-startup-worker", "2.0.0")
        self.web = self.root / "web"
        self.web.mkdir()
        pkg = {"name": "sf-startup-regression", "version": "1.0.0", "private": True,
               "dependencies": {"sf-fixture-browser": "^2.0.0"},
               "devDependencies": {"sf-fixture-build": "^3.0.0"}}
        self.lock = {"name": pkg["name"], "version": pkg["version"], "lockfileVersion": 3,
                     "packages": {"": pkg, "node_modules/sf-fixture-browser": {"version": "2.0.0"},
                                  "node_modules/sf-fixture-build": {"version": "3.0.0", "dev": True,
                                                                      "bin": {"sf-build": "bin/build.js"}}}}
        (self.web / "package.json").write_text(json.dumps(pkg))
        self.write_lock()
        self.driver = self.root / "fake_installers.py"
        self.driver.write_text(INSTALLER_DRIVER)
        self.npm = self.root / "npm-fixture"
        self.npm.write_text("#!/usr/bin/env bash\nexec " + shlex.quote(sys.executable) + " " + shlex.quote(str(self.driver)) + ' npm "$@"\n')
        self.npm.chmod(0o755)
        self.environment = {**os.environ, "PYTHONPATH": str(self.site), "FIXTURE_ROOT": str(self.root),
                            "REAL_NPM": shutil.which("npm"), "npm_config_cache": str(self.root / "npm-cache"),
                            "npm_config_userconfig": str(self.root / "npmrc"), "npm_config_globalconfig": str(self.root / "globalnpmrc"),
                            "npm_config_update_notifier": "false", "npm_config_registry": "http://127.0.0.1:9",
                            "SLIDEFLOW_FORCE_BUILD": "0"}
        for filename in ("npmrc", "globalnpmrc"):
            (self.root / filename).write_text("")
        subprocess.run([sys.executable, str(self.driver), "npm", "ci"], env=self.environment, check=True)
        (self.root / "commands.jsonl").unlink()

    def write_lock(self):
        (self.web / "package-lock.json").write_text(json.dumps(self.lock))

    def commands(self):
        log = self.root / "commands.jsonl"
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def installations(self):
        return [item for item in self.commands() if item["kind"] == "pip" or item["args"][0] in ("ci", "install")]

    def run_startup(self, *, production=False, build=False, **environment):
        source = (ROOT / "run.sh").read_text()
        start = source.index("# Step 4 - ")
        end = source.index("# Step 6 - " if build else "# Step 5.5 - ")
        variables = {"ROOT_DIR": str(self.root), "PYTHON_BIN": sys.executable, "PYTHON_CMD": sys.executable,
                     "NODE_BIN": shutil.which("node"), "NPM_BIN": str(self.npm), "DEV_MODE": "false" if production else "true"}
        header = "set -euo pipefail\n" + "\n".join(f"{name}={shlex.quote(value)}" for name, value in variables.items())
        header += "\nPIP_INSTALL=(" + shlex.quote(sys.executable) + " " + shlex.quote(str(self.driver)) + " pip)\n"
        header += 'log_info() { printf "%s\\n" "$*"; }; log_warn() { log_info "$@"; }; log_error() { log_info "$@"; };\n'
        script = header + source[start:end] + '\nprintf "BACKEND_SERVER=%s\\n" "$BACKEND_SERVER"\n'
        return subprocess.run(["bash", "-c", script], cwd=self.root, env={**self.environment, **environment}, capture_output=True, text=True, timeout=30)

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_satisfied_restarts_do_not_install_and_npm_checks_are_offline(self):
        self.assert_success(self.run_startup())
        receipt = self.web / "node_modules/.slideflow-dependencies.json"
        timestamp = receipt.stat().st_mtime_ns
        self.assert_success(self.run_startup())
        self.assertEqual(self.installations(), [])
        self.assertEqual(receipt.stat().st_mtime_ns, timestamp)
        self.assertTrue(all("--offline" in item["args"] for item in self.commands()))

    def test_check_only_does_not_write_a_receipt(self):
        result = subprocess.run([shutil.which("node"), str(ROOT / "tools/check_frontend_dependencies.mjs"),
                                 str(self.web), str(self.npm), "--check-only"],
                                env=self.environment, capture_output=True, text=True)
        self.assert_success(result)
        self.assertFalse((self.web / "node_modules/.slideflow-dependencies.json").exists())
        self.assertEqual(self.installations(), [])

    def test_outdated_python_distribution_is_installed_once_then_verified(self):
        distribution(self.site, "sf-startup-core", "1.0.0")
        self.assert_success(self.run_startup())
        self.assert_success(self.run_startup())
        self.assertEqual(self.installations(), [{"kind": "pip", "args": ["-r", "requirements.txt"]}])

    def test_missing_python_metadata_triggers_install_even_with_module(self):
        shutil.rmtree(self.site / "sf_startup_core-2.0.0.dist-info")
        (self.site / "sf_startup_core.py").write_text("VALUE = 1\n")
        self.assert_success(self.run_startup())
        self.assertEqual(len(self.installations()), 1)

    def test_changed_python_declaration_is_read_on_every_restart(self):
        self.assert_success(self.run_startup())
        (self.root / "requirements.txt").write_text("sf-startup-core>=2.4,<3\n")
        self.assert_success(self.run_startup())
        self.assertEqual(len(self.installations()), 1)

    def test_failed_and_incomplete_python_installs_cannot_report_success(self):
        distribution(self.site, "sf-startup-core", "1.0.0")
        for behavior in ("fail", "incomplete"):
            with self.subTest(behavior=behavior):
                result = self.run_startup(FAKE_PIP_BEHAVIOR=behavior)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Python 依赖安装完成", result.stdout)
                self.assertNotIn("BACKEND_SERVER=", result.stdout)

    def test_invalid_python_declaration_is_not_treated_as_missing_package(self):
        (self.root / "requirements.txt").write_text("--unsupported-option value\n")
        result = self.run_startup()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.installations(), [])

    def test_missing_frontend_installs_lockfile_with_build_dependencies(self):
        shutil.rmtree(self.web / "node_modules")
        self.assert_success(self.run_startup(NODE_ENV="production"))
        self.assertEqual(len(self.installations()), 1)
        self.assertEqual(self.installations()[0]["args"][0], "ci")
        self.assertIn("--include=dev", self.installations()[0]["args"])
        self.assertTrue((self.web / "node_modules/sf-fixture-build/package.json").exists())

    def test_changed_lockfile_updates_installed_version_once(self):
        self.assert_success(self.run_startup())
        self.lock["packages"]["node_modules/sf-fixture-browser"]["version"] = "2.1.0"
        self.write_lock()
        self.assert_success(self.run_startup())
        installed = json.loads((self.web / "node_modules/sf-fixture-browser/package.json").read_text())
        self.assertEqual(installed["version"], "2.1.0")
        self.assert_success(self.run_startup())
        self.assertEqual(len(self.installations()), 1)

    def test_changed_lockfile_with_same_versions_still_synchronizes(self):
        self.assert_success(self.run_startup())
        self.lock["packages"]["node_modules/sf-fixture-browser"]["integrity"] = "sha512-fixture"
        self.write_lock()
        self.assert_success(self.run_startup())
        self.assertEqual(len(self.installations()), 1)

    def test_missing_build_binary_is_repaired_even_with_matching_receipt(self):
        self.assert_success(self.run_startup())
        (self.web / "node_modules/.bin/sf-build").unlink()
        self.assert_success(self.run_startup())
        self.assertEqual(len(self.installations()), 1)

    def test_failed_and_incomplete_frontend_installs_cannot_report_success(self):
        self.assert_success(self.run_startup())
        old_receipt = (self.web / "node_modules/.slideflow-dependencies.json").read_text()
        self.lock["packages"]["node_modules/sf-fixture-browser"]["version"] = "2.1.0"
        self.write_lock()
        for behavior in ("fail", "incomplete"):
            with self.subTest(behavior=behavior):
                result = self.run_startup(FAKE_NPM_BEHAVIOR=behavior)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("前端依赖安装完成", result.stdout)
                self.assertEqual((self.web / "node_modules/.slideflow-dependencies.json").read_text(), old_receipt)

    def test_package_and_lock_disagreement_fails_without_an_install_loop(self):
        pkg = json.loads((self.web / "package.json").read_text())
        pkg["dependencies"]["sf-fixture-browser"] = "^3.0.0"
        (self.web / "package.json").write_text(json.dumps(pkg))
        result = self.run_startup()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("update the lockfile first", result.stderr)
        self.assertEqual(self.installations(), [])

    def test_missing_optional_platform_package_does_not_trigger_reinstall(self):
        self.lock["packages"]["node_modules/sf-optional-platform"] = {"version": "1.0.0", "optional": True, "os": ["fixture-os"]}
        self.write_lock()
        self.assert_success(self.run_startup())
        self.assertEqual(self.installations(), [])

    def test_no_lockfile_uses_install_and_verifies_generated_lock(self):
        (self.web / "package-lock.json").unlink()
        shutil.rmtree(self.web / "node_modules")
        self.assert_success(self.run_startup())
        self.assertEqual(self.installations()[0]["args"][0], "install")
        self.assertTrue((self.web / "node_modules/.slideflow-dependencies.json").exists())

    def test_outdated_production_dependency_is_upgraded_once(self):
        distribution(self.site, "sf-startup-worker", "1.0.0")
        result = self.run_startup(production=True)
        self.assert_success(result)
        self.assertIn("BACKEND_SERVER=gunicorn", result.stdout)
        self.assertEqual(self.installations(), [{"kind": "pip", "args": ["-r", "requirements.txt"]}])

    def test_production_install_failure_stops_startup(self):
        distribution(self.site, "sf-startup-worker", "1.0.0")
        for behavior in ("fail", "incomplete"):
            with self.subTest(behavior=behavior):
                result = self.run_startup(production=True, FAKE_PIP_BEHAVIOR=behavior)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("BACKEND_SERVER=", result.stdout)

    def test_damaging_install_cannot_leave_broken_base_dependencies(self):
        distribution(self.site, "sf-startup-worker", "1.0.0")
        result = self.run_startup(production=True, FAKE_PIP_BEHAVIOR="damage")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("安装后 Python 依赖仍未满足要求", result.stdout)

    def test_production_restart_reuses_build_and_does_not_install(self):
        self.assert_success(self.run_startup(production=True, build=True))
        self.assert_success(self.run_startup(production=True, build=True))
        self.assertEqual(self.installations(), [])
        builds = [item for item in self.commands() if item["args"][:2] == ["run", "build"]]
        self.assertEqual(len(builds), 1)

    def test_build_failure_keeps_existing_output_and_fails_without_it(self):
        output = self.root / "app/static/dist/index.html"
        output.parent.mkdir(parents=True)
        output.write_text("<html>previous build</html>")
        result = self.run_startup(production=True, build=True, FAKE_BUILD_BEHAVIOR="fail")
        self.assert_success(result)
        self.assertEqual(output.read_text(), "<html>previous build</html>")
        self.assertIn("降级使用现有前端产物", result.stdout)
        output.unlink()
        result = self.run_startup(production=True, build=True, FAKE_BUILD_BEHAVIOR="fail")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("无现有产物可降级", result.stdout)


if __name__ == "__main__":
    unittest.main()
