#!/usr/bin/env node

/**
 * Generate release notes from git commits since the last tag
 *
 * Usage:
 *   node scripts/generate-release-notes.js           # commits since last tag
 *   node scripts/generate-release-notes.js v0.15.0   # commits since specific tag
 *
 * Output format matches CHANGELOG.md style with commit hyperlinks
 */

import { execSync } from 'child_process';

// Get repo info from package.json or git remote
function getRepoUrl() {
  try {
    // Try to get from git remote
    const remote = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
    // Convert SSH to HTTPS format
    if (remote.startsWith('git@github.com:')) {
      return remote.replace('git@github.com:', 'https://github.com/').replace(/\.git$/, '');
    }
    if (remote.startsWith('https://github.com/')) {
      return remote.replace(/\.git$/, '');
    }
    // Fallback to package.json
    const pkg = JSON.parse(execSync('cat package.json', { encoding: 'utf-8' }));
    if (pkg.repository?.url) {
      return pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
    }
  } catch {
    // Default fallback
  }
  return 'https://github.com/gronkanium/gronka';
}

// Get the last tag or use provided tag
function getLastTag(providedTag) {
  if (providedTag) return providedTag;
  try {
    return execSync('git describe --tags --abbrev=0 HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    // No tags exist, get first commit
    return execSync('git rev-list --max-parents=0 HEAD', { encoding: 'utf-8' }).trim();
  }
}

// Get commits since tag
function getCommitsSince(tag) {
  try {
    const format = '%H|%s'; // hash|subject
    const log = execSync(`git log ${tag}..HEAD --pretty=format:"${format}" --no-merges`, {
      encoding: 'utf-8',
    });
    if (!log.trim()) return [];

    return log
      .trim()
      .split('\n')
      .map(line => {
        const [hash, ...subjectParts] = line.split('|');
        return {
          hash: hash.substring(0, 7), // Short hash
          fullHash: hash,
          subject: subjectParts.join('|'), // In case subject contains |
        };
      });
  } catch {
    return [];
  }
}

// Parse conventional commit message
function parseCommit(subject) {
  // Match: type(scope): message or type: message
  const match = subject.match(/^(\w+)(?:\(([^)]+)\))?:\s*(.+)$/);
  if (match) {
    return {
      type: match[1].toLowerCase(),
      scope: match[2] || null,
      message: match[3],
    };
  }
  // Non-conventional commit
  return {
    type: 'other',
    scope: null,
    message: subject,
  };
}

// Map commit types to changelog categories
const categoryMap = {
  feat: 'Added',
  feature: 'Added',
  add: 'Added',
  fix: 'Fixed',
  bugfix: 'Fixed',
  hotfix: 'Fixed',
  change: 'Changed',
  refactor: 'Changed',
  perf: 'Changed',
  style: 'Changed',
  docs: 'Documentation',
  doc: 'Documentation',
  test: 'Testing',
  tests: 'Testing',
  chore: 'Maintenance',
  build: 'Maintenance',
  ci: 'Maintenance',
  deps: 'Dependencies',
  dep: 'Dependencies',
  security: 'Security',
  sec: 'Security',
  breaking: 'Breaking Changes',
  remove: 'Removed',
  removed: 'Removed',
  deprecate: 'Deprecated',
  deprecated: 'Deprecated',
};

// Category display order
const categoryOrder = [
  'Breaking Changes',
  'Added',
  'Changed',
  'Fixed',
  'Security',
  'Deprecated',
  'Removed',
  'Documentation',
  'Dependencies',
  'Testing',
  'Maintenance',
  'Other',
];

function main() {
  const repoUrl = getRepoUrl();
  const providedTag = process.argv[2];
  const lastTag = getLastTag(providedTag);
  const commits = getCommitsSince(lastTag);

  if (commits.length === 0) {
    console.log(`No commits found since ${lastTag}`);
    process.exit(0);
  }

  // Group commits by category
  const categories = {};

  for (const commit of commits) {
    const parsed = parseCommit(commit.subject);
    const category = categoryMap[parsed.type] || 'Other';

    if (!categories[category]) {
      categories[category] = [];
    }

    // Format: - Message ([`hash`](url))
    const commitLink = `[\`${commit.hash}\`](${repoUrl}/commit/${commit.fullHash})`;
    let entry = `- ${parsed.message} (${commitLink})`;

    categories[category].push(entry);
  }

  // Output
  console.log(`## [Unreleased]`);
  console.log('');
  console.log(`_${commits.length} commits since ${lastTag}_`);
  console.log('');

  for (const category of categoryOrder) {
    if (categories[category] && categories[category].length > 0) {
      console.log(`### ${category}`);
      console.log('');
      for (const entry of categories[category]) {
        console.log(entry);
      }
      console.log('');
    }
  }

  // Footer with instructions
  console.log('---');
  console.log('');
  console.log('**Next steps:**');
  console.log('1. Review and edit the notes above');
  console.log('2. Copy to CHANGELOG.md under the new version header');
  console.log('3. Update package.json version');
  console.log('4. Commit and tag: `git tag v{version} && git push --tags`');
}

main();
