#!/usr/bin/env node
// Local checks only. Exit 1 requests an install; exit 2 is a checker/config error.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

class NeedsInstall extends Error {}

const [directory, npm, mode] = process.argv.slice(2);
const record = mode === '--record';
const checkOnly = mode === '--check-only';

function readJson(filename, optional = false) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw new Error(`Cannot read valid JSON from ${path.basename(filename)}`);
  }
}

function sortedRecord(value = {}) {
  return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function check() {
  if (!directory || !npm || (mode && !record && !checkOnly)) throw new Error('Usage: check_frontend_dependencies.mjs WEB_DIR NPM [--record|--check-only]');
  const root = path.resolve(directory);
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const modules = path.join(root, 'node_modules');
  const receiptPath = path.join(modules, '.slideflow-dependencies.json');
  const pkg = readJson(packagePath);
  const lock = readJson(lockPath, true);
  if (lock && (![2, 3].includes(lock.lockfileVersion) || !lock.packages || !lock.packages[''])) {
    throw new Error('Dependency checking requires a package-lock.json with lockfileVersion 2 or 3');
  }
  if (lock) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      if (sortedRecord(pkg[field]) !== sortedRecord(lock.packages[''][field])) {
        throw new Error(`package.json and package-lock.json disagree on ${field}; update the lockfile first`);
      }
    }
  }
  const digest = createHash('sha256').update(fs.readFileSync(packagePath)).update('\0');
  if (lock) digest.update(fs.readFileSync(lockPath));
  digest.update(`\0v1:${process.platform}:${process.arch}:${process.versions.modules}`);
  const fingerprint = digest.digest('hex');
  if (!fs.existsSync(modules)) throw new NeedsInstall('node_modules is missing');
  let receipt = null;
  try {
    receipt = readJson(receiptPath, true);
  } catch {
    if (!record) throw new NeedsInstall('Dependency receipt is invalid');
  }
  if (!record && receipt && receipt.fingerprint !== fingerprint) {
    throw new NeedsInstall('package.json, package-lock.json, or the Node runtime changed');
  }
  if (lock) {
    let installedLock;
    try {
      installedLock = readJson(path.join(modules, '.package-lock.json'), true);
    } catch {
      throw new NeedsInstall('Installed lockfile is invalid');
    }
    if (!installedLock?.packages) throw new NeedsInstall('Installed lockfile is missing');
    for (const [location, expected] of Object.entries(lock.packages)) {
      if (!location) continue;
      if (!location.startsWith('node_modules/') || location.split('/').includes('..') || expected.link) {
        throw new Error('Cannot verify linked or external packages with this startup checker');
      }
      const packageDirectory = path.join(root, location);
      const manifest = path.join(packageDirectory, 'package.json');
      if (!fs.existsSync(manifest) && expected.optional) continue;
      let installed;
      try {
        installed = readJson(manifest);
      } catch {
        throw new NeedsInstall(`Missing or invalid package: ${location}`);
      }
      if (installed.version !== expected.version) throw new NeedsInstall(`Version differs from lockfile: ${location}`);
      const installedEntry = installedLock.packages[location];
      if (!installedEntry || ['version', 'resolved', 'integrity'].some(key => expected[key] !== installedEntry[key])) {
        throw new NeedsInstall(`Installed lockfile is out of sync: ${location}`);
      }
      const bins = typeof expected.bin === 'string'
        ? { [installed.name.split('/').pop()]: expected.bin } : expected.bin || {};
      const dependencyRoot = location.slice(0, location.lastIndexOf('node_modules/') + 'node_modules/'.length);
      for (const [name, target] of Object.entries(bins)) {
        if (!fs.existsSync(path.join(packageDirectory, target)) || !fs.existsSync(path.join(root, dependencyRoot, '.bin', name))) {
          throw new NeedsInstall(`Package executable is missing: ${location} (${name})`);
        }
      }
    }
  }
  // npm checks dependency ranges and peer/transitive dependencies. --offline
  // guarantees that the ordinary restart check cannot contact a registry.
  const result = spawnSync(npm, ['ls', '--all', '--include=dev', '--include=optional', '--json', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error('Cannot execute the local npm dependency check');
  if (result.status !== 0) throw new NeedsInstall('npm ls found missing or invalid dependencies');
  let tree;
  try { tree = JSON.parse(result.stdout); } catch { throw new Error('npm ls did not return a valid dependency tree'); }
  if (!tree || tree.problems?.length) throw new NeedsInstall('npm ls reported dependency problems');
  if (pkg.name && tree.name !== pkg.name) throw new Error('npm ls returned a different project');
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })) {
    if (pkg.optionalDependencies?.[name]) continue;
    if (pkg.peerDependenciesMeta?.[name]?.optional && !pkg.dependencies?.[name] && !pkg.devDependencies?.[name]) continue;
    if (!tree.dependencies?.[name] || tree.dependencies[name].missing || tree.dependencies[name].invalid) {
      throw new NeedsInstall('Required dependency is missing or invalid: ' + name);
    }
  }
  if (!checkOnly && (record || !receipt)) {
    // Keep this under node_modules so it cannot invalidate the source/build hash.
    const temporary = `${receiptPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ fingerprint }) + '\n');
      fs.renameSync(temporary, receiptPath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}

try {
  check();
} catch (error) {
  console.error(`Frontend dependency check: ${error.message}`);
  process.exitCode = error instanceof NeedsInstall ? 1 : 2;
}
