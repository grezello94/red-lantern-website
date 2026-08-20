#!/usr/bin/env node

const { execSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

const pkg = JSON.parse(readFileSync(require('node:path').join(__dirname, '..', 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

function run(command) {
  execSync(command, { stdio: 'inherit' });
}

try {
  run('git diff --quiet');
  run('git diff --cached --quiet');
} catch {
  console.error('Working tree has uncommitted changes. Commit before creating a release tag.');
  process.exit(1);
}

try {
  run(`git tag -a ${tag} -m "Release ${tag}"`);
  console.log(`Created release tag: ${tag}`);
} catch (error) {
  console.error(`Failed to create tag ${tag}:`, error.message);
  process.exit(1);
}
