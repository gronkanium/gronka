#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import tmp from 'tmp';

import { convertAllWikiFiles } from './convert-wiki-links.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const wikiDir = path.join(projectRoot, 'wiki');

const GITHUB_WIKI_URL = 'https://github.com/gronkanium/gronka.wiki.git';

/**
 * Check if git is available
 */
function checkGitAvailable() {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone GitHub Wiki repository to temporary directory
 */
function cloneWikiRepo(tempDir) {
  console.log('Cloning GitHub Wiki repository...');
  try {
    execSync(`git clone ${GITHUB_WIKI_URL} .`, {
      cwd: tempDir,
      stdio: 'inherit',
    });
    console.log('✓ Wiki repository cloned');
    return true;
  } catch (error) {
    console.error('✗ Failed to clone wiki repository:', error.message);
    return false;
  }
}

/**
 * Initialize git repository if clone failed (first time setup)
 */
function initWikiRepo(tempDir) {
  console.log('Initializing new wiki repository...');
  try {
    execSync('git init', { cwd: tempDir, stdio: 'inherit' });
    execSync(`git remote add origin ${GITHUB_WIKI_URL}`, {
      cwd: tempDir,
      stdio: 'inherit',
    });
    console.log('✓ Wiki repository initialized');
    return true;
  } catch (error) {
    console.error('✗ Failed to initialize wiki repository:', error.message);
    return false;
  }
}

/**
 * Copy converted wiki files to the wiki repository
 */
function copyWikiFiles(tempDir, convertedFiles) {
  console.log('Copying converted wiki files...');
  let copied = 0;

  for (const [filename, content] of Object.entries(convertedFiles)) {
    const destPath = path.join(tempDir, filename);
    fs.writeFileSync(destPath, content, 'utf-8');
    copied++;
    console.log(`  ✓ ${filename}`);
  }

  console.log(`✓ Copied ${copied} files`);
  return copied;
}

/**
 * Configure git user name and email in the temporary directory
 */
function configureGitUser(tempDir) {
  try {
    // Try to get git config from the main repository
    let userName = '';
    let userEmail = '';

    try {
      userName = execSync('git config user.name', {
        cwd: projectRoot,
        encoding: 'utf-8',
      }).trim();
    } catch {
      // Fallback to environment variable or default
      userName = process.env.GIT_USER_NAME || 'gronka-bot';
    }

    try {
      userEmail = execSync('git config user.email', {
        cwd: projectRoot,
        encoding: 'utf-8',
      }).trim();
    } catch {
      // Fallback to environment variable or default
      userEmail = process.env.GIT_USER_EMAIL || 'noreply@github.com';
    }

    // Set git config in the temporary directory
    execSync(`git config user.name "${userName}"`, {
      cwd: tempDir,
      stdio: 'ignore',
    });
    execSync(`git config user.email "${userEmail}"`, {
      cwd: tempDir,
      stdio: 'ignore',
    });

    return true;
  } catch (error) {
    console.error('✗ Failed to configure git user:', error.message);
    return false;
  }
}

/**
 * Commit and push changes to GitHub Wiki
 */
function commitAndPush(tempDir) {
  // Configure git user before committing
  if (!configureGitUser(tempDir)) {
    return false;
  }

  console.log('Committing changes...');
  try {
    // Check if there are any changes
    try {
      execSync('git diff --quiet', { cwd: tempDir, stdio: 'ignore' });
      // No changes
      try {
        execSync('git diff --cached --quiet', { cwd: tempDir, stdio: 'ignore' });
        console.log('ℹ No changes to commit');
        return true;
      } catch {
        // There are staged changes
      }
    } catch {
      // There are unstaged changes
    }

    // Add all files
    execSync('git add -A', { cwd: tempDir, stdio: 'inherit' });

    // Check if there are any changes to commit
    try {
      execSync('git diff --cached --quiet', { cwd: tempDir, stdio: 'ignore' });
      console.log('ℹ No changes to commit');
      return true;
    } catch {
      // There are staged changes, proceed with commit
    }

    // Commit
    try {
      const commitMessage = `Update wiki from local repository\n\nSynced from wiki/ directory at ${new Date().toISOString()}`;
      execSync(`git commit -m "${commitMessage}"`, {
        cwd: tempDir,
        stdio: 'inherit',
      });
      console.log('✓ Changes committed');
    } catch (commitError) {
      console.error('✗ Failed to commit changes:', commitError.message);
      return false;
    }

    // Push to GitHub - try master first, then main
    console.log('Pushing to GitHub Wiki...');
    try {
      execSync('git push origin master', {
        cwd: tempDir,
        stdio: 'inherit',
      });
      console.log('✓ Changes pushed to GitHub Wiki');
      return true;
    } catch (masterError) {
      // Try main branch if master fails
      try {
        execSync('git push origin main', {
          cwd: tempDir,
          stdio: 'inherit',
        });
        console.log('✓ Changes pushed to GitHub Wiki (main branch)');
        return true;
      } catch (mainError) {
        console.error('✗ Failed to push to GitHub Wiki');
        console.error('  Master branch error:', masterError.message);
        console.error('  Main branch error:', mainError.message);
        return false;
      }
    }
  } catch (error) {
    console.error('✗ Unexpected error:', error.message);
    return false;
  }
}

/**
 * Main sync function
 */
function syncWikiToGitHub() {
  console.log('Syncing wiki to GitHub...\n');

  // Check prerequisites
  if (!checkGitAvailable()) {
    console.error('✗ Git is not available. Please install Git and try again.');
    process.exit(1);
  }

  if (!fs.existsSync(wikiDir)) {
    console.error(`✗ Wiki directory not found: ${wikiDir}`);
    process.exit(1);
  }

  // Create temporary directory
  const tmpDir = tmp.dirSync({ unsafeCleanup: true });
  const tempDir = tmpDir.name;

  try {
    // Convert wiki files
    console.log('Converting wiki links...');
    const convertedFiles = convertAllWikiFiles();
    console.log(`✓ Converted ${Object.keys(convertedFiles).length} files\n`);

    // Clone or initialize wiki repository
    const cloned = cloneWikiRepo(tempDir);
    if (!cloned) {
      // Try to initialize if clone failed (might be first time)
      if (!initWikiRepo(tempDir)) {
        console.error('✗ Failed to set up wiki repository');
        process.exit(1);
      }
    }

    // Copy converted files
    copyWikiFiles(tempDir, convertedFiles);
    console.log();

    // Commit and push
    if (!commitAndPush(tempDir)) {
      console.error('✗ Failed to sync wiki to GitHub');
      process.exit(1);
    }

    console.log('\n✓ Wiki sync completed successfully!');
  } catch (error) {
    console.error('✗ Error syncing wiki:', error.message);
    process.exit(1);
  } finally {
    // Clean up temporary directory
    tmpDir.removeCallback();
  }
}

// Run sync if this is the main module
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')));

if (isMainModule) {
  syncWikiToGitHub();
}

export { syncWikiToGitHub };
