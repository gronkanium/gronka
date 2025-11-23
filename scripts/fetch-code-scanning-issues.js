#!/usr/bin/env node

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoOwner = 'thedorekaczynski';
const repoName = 'gronka';
const outputFile = join(__dirname, '..', 'code-scanning-issues.json');

console.log('Fetching code scanning alerts from GitHub...');

try {
  // Check if gh CLI is available
  try {
    execSync('gh --version', { stdio: 'pipe' });
  } catch {
    console.error('Error: GitHub CLI (gh) is not installed or not in PATH');
    console.error('Install it from: https://cli.github.com/');
    process.exit(1);
  }

  // Fetch code scanning alerts with pagination
  // GitHub API returns max 30 items per page by default, we'll use 100 and paginate
  const apiEndpoint = `/repos/${repoOwner}/${repoName}/code-scanning/alerts`;
  const perPage = 100;
  let allAlerts = [];
  let page = 1;
  let hasMore = true;

  console.log(`Fetching from: ${apiEndpoint}`);
  console.log('Fetching all pages (this may take a moment)...');

  // Fetch all pages of alerts
  while (hasMore) {
    try {
      const queryParams = `state=open&per_page=${perPage}&page=${page}`;
      const fullEndpoint = `${apiEndpoint}?${queryParams}`;

      const output = execSync(`gh api "${fullEndpoint}"`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        cwd: join(__dirname, '..'),
      });

      let pageAlerts;
      try {
        pageAlerts = JSON.parse(output);
      } catch {
        console.error('Error: Failed to parse API response');
        console.error('Response:', output);
        process.exit(1);
      }

      // Handle empty array or no alerts
      if (!Array.isArray(pageAlerts)) {
        console.error('Error: Unexpected API response format');
        console.error('Response:', pageAlerts);
        process.exit(1);
      }

      allAlerts = allAlerts.concat(pageAlerts);
      console.log(`  Fetched page ${page}: ${pageAlerts.length} alert(s)`);

      // If we got fewer than perPage results, we're done
      if (pageAlerts.length < perPage) {
        hasMore = false;
      } else {
        page++;
      }
    } catch (error) {
      // If we get a 404 on a later page, we're done
      if (error.status === 404 || (error.stderr && error.stderr.includes('404'))) {
        hasMore = false;
      } else {
        throw error;
      }
    }
  }

  // Filter to only open/unfixed issues (should already be filtered by API, but double-check)
  const openAlerts = allAlerts.filter(alert => alert.state === 'open');
  const totalAlerts = allAlerts.length;

  // Save only open issues to JSON file
  const formattedOutput = JSON.stringify(openAlerts, null, 2);
  writeFileSync(outputFile, formattedOutput, 'utf-8');

  console.log(`✓ Successfully fetched ${totalAlerts} total alert(s)`);
  console.log(`✓ Found ${openAlerts.length} open/unfixed issue(s)`);
  console.log(`✓ Saved ${openAlerts.length} open issue(s) to: ${outputFile}`);

  if (openAlerts.length === 0) {
    console.log('\nNo open code scanning alerts found. All issues are fixed!');
    process.exit(0);
  }

  // Display summary
  console.log('\nOpen Alert Summary:');
  openAlerts.forEach((alert, index) => {
    const rule = alert.rule?.name || 'Unknown rule';
    const severity = alert.rule?.severity || 'unknown';
    const state = alert.state || 'unknown';
    const file = alert.most_recent_instance?.location?.path || 'unknown';
    console.log(`  ${index + 1}. [${severity.toUpperCase()}] ${rule} - ${file} (${state})`);
  });

  process.exit(0);
} catch (error) {
  if (error.status === 404) {
    console.error('Error: Repository not found or code scanning is not enabled');
    console.error('Make sure code scanning is enabled in the repository settings');
  } else if (error.status === 401 || error.status === 403) {
    console.error('Error: Authentication failed');
    console.error('Run: gh auth login');
  } else {
    console.error('Error fetching code scanning alerts:', error.message);
    if (error.stdout) {
      console.error('stdout:', error.stdout);
    }
    if (error.stderr) {
      console.error('stderr:', error.stderr);
    }
  }
  process.exit(1);
}
