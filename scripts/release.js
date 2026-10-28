#!/usr/bin/env bun
// Dated releases (vYYYY.MM.DD, .N for another that day) cut from origin/master by the owner.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'gronkanium/gronka';
const URL = `https://github.com/${REPO}`;
const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Bug Fixes'],
  ['perf', 'Performance Improvements'],
  ['revert', 'Reverts'],
  ['deps', 'Dependencies'],
];
const CONVENTIONAL =
  /^(feat|fix|perf|revert|deps|docs|chore|refactor|test|ci|build|style)(?:\(([^)]+)\))?(!)?: (.+)$/;

export function nextVersion(date, tags) {
  const base = date.toISOString().slice(0, 10).replaceAll('-', '.');
  const taken = tags.filter(t => t === `v${base}` || t.startsWith(`v${base}.`)).length;
  return taken ? `${base}.${taken}` : base;
}

// A squash merge whose body lists conventional subjects contributes those, not its own subject.
export function changelogEntries(commits) {
  return commits.flatMap(({ sha, message }) => {
    const [subject, ...body] = message.trim().split('\n');
    const pr = subject.match(/ \(#(\d+)\)$/)?.[1];
    const footer = message.match(/^BREAKING[ -]CHANGE: (.+)$/m)?.[1];
    const nested = body.map(l => l.replace(/^\* /, '').match(CONVENTIONAL)).filter(Boolean);
    const own = subject.replace(/ \(#\d+\)$/, '').match(CONVENTIONAL);
    return (nested.length ? nested : [own].filter(Boolean)).map(m => ({
      type: m[1],
      scope: m[2],
      text: m[4],
      breaking: m[3] ? m[4] : nested.length ? undefined : footer,
      sha,
      pr,
    }));
  });
}

export function renderNotes(entries) {
  const line = (e, text = e.text) =>
    `* ${e.scope ? `**${e.scope}:** ` : ''}${text}${e.pr ? ` ([#${e.pr}](${URL}/issues/${e.pr}))` : ''} ([${e.sha.slice(0, 7)}](${URL}/commit/${e.sha}))`;
  const sorted = [...entries].sort((a, b) =>
    `${a.scope ?? ''} ${a.text}`.localeCompare(`${b.scope ?? ''} ${b.text}`)
  );
  const groups = [
    ['⚠ BREAKING CHANGES', sorted.filter(e => e.breaking).map(e => line(e, e.breaking))],
    ...SECTIONS.map(([type, title]) => [
      title,
      sorted.filter(e => e.type === type).map(e => line(e)),
    ]),
  ];
  return groups
    .filter(([, lines]) => lines.length)
    .map(([title, lines]) => `### ${title}\n\n${lines.join('\n')}`)
    .join('\n\n\n');
}

const run = (cmd, args, opts) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
const fail = msg => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run');
  run('git', ['fetch', '--quiet', '--tags', 'origin', 'master']);
  const head = run('git', ['rev-parse', 'HEAD']);
  if (!dryRun) {
    if (head !== run('git', ['rev-parse', 'origin/master'])) fail('check out origin/master first');
    if (run('git', ['status', '--porcelain'])) fail('working tree is not clean');
    const ci = run('gh', [
      'run',
      'list',
      '-R',
      REPO,
      '--workflow',
      'ci.yml',
      '--commit',
      head,
      '--json',
      'conclusion',
      '--jq',
      '.[0].conclusion',
    ]);
    if (ci !== 'success') fail(`CI on ${head.slice(0, 7)} is "${ci || 'not run'}", wait for green`);
  }

  const prev = run('git', ['describe', '--tags', '--abbrev=0', 'HEAD']);
  const commits = run('git', ['log', '--format=%H%x1f%B%x1e', `${prev}..HEAD`])
    .split('\x1e')
    .filter(s => s.trim())
    .map(s => {
      const [sha, message] = s.trim().split('\x1f');
      return { sha, message };
    });
  const notes = renderNotes(changelogEntries(commits));
  if (!notes) fail(`nothing to release since ${prev} (no feat, fix, perf, revert or deps commits)`);

  const now = new Date();
  const version = nextVersion(now, run('git', ['tag', '-l', 'v*']).split('\n'));
  const tag = `v${version}`;
  if (dryRun) {
    console.log(`${tag} (since ${prev})\n\n${notes}`);
    process.exit(0);
  }

  const pkg = readFileSync('package.json', 'utf8');
  writeFileSync('package.json', pkg.replace(/"version": "[^"]+"/, `"version": "${version}"`));
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  const at = changelog.indexOf('\n## ');
  const header = `## [${version}](${URL}/compare/${prev}...${tag}) (${now.toISOString().slice(0, 10)})`;
  writeFileSync(
    'CHANGELOG.md',
    `${changelog.slice(0, at)}\n${header}\n\n\n${notes}\n${changelog.slice(at)}`
  );

  run('git', [
    'commit',
    '--quiet',
    '-m',
    `chore: release ${version}`,
    'package.json',
    'CHANGELOG.md',
  ]);
  run('git', ['tag', '-a', tag, '-m', tag]);
  run('git', ['push', '--atomic', 'origin', 'HEAD:refs/heads/master', `refs/tags/${tag}`]);
  run(
    'gh',
    [
      'release',
      'create',
      tag,
      '-R',
      REPO,
      '--title',
      tag,
      '--verify-tag',
      '--latest',
      '--notes-file',
      '-',
    ],
    { input: notes }
  );

  // PRs carry the "next" milestone until the release that ships them names it.
  const milestones = JSON.parse(run('gh', ['api', `repos/${REPO}/milestones`]));
  const next = milestones.find(m => m.title === 'next');
  if (next) {
    run('gh', [
      'api',
      '-X',
      'PATCH',
      `repos/${REPO}/milestones/${next.number}`,
      '-f',
      `title=${tag}`,
      '-f',
      'state=closed',
    ]);
  }
  run('gh', ['api', '-X', 'POST', `repos/${REPO}/milestones`, '-f', 'title=next']);
  console.log(`released ${tag}: ${URL}/releases/tag/${tag}`);
}
