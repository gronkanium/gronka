#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const DATA_DIR = path.join(projectRoot, 'data');
const OLD_GIFS_DIR = path.join(DATA_DIR, 'gifs', 'gifs');
const OLD_VIDEOS_DIR = path.join(DATA_DIR, 'gifs', 'videos');
const NEW_GIFS_DIR = path.join(DATA_DIR, 'gifs');
const NEW_VIDEOS_DIR = path.join(DATA_DIR, 'videos');

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function moveFiles(sourceDir, destDir, type) {
  if (!(await fileExists(sourceDir))) {
    console.log(`  ${type}: source directory doesn't exist, skipping`);
    return { moved: 0, skipped: 0, errors: 0 };
  }

  let files;
  try {
    files = await fs.readdir(sourceDir);
  } catch (error) {
    console.error(`  ${type}: error reading source directory:`, error.message);
    return { moved: 0, skipped: 0, errors: 1 };
  }

  // Filter out directories, only process files
  const fileStats = await Promise.all(
    files.map(async file => {
      const filePath = path.join(sourceDir, file);
      try {
        const stat = await fs.stat(filePath);
        return { file, isFile: stat.isFile() };
      } catch {
        return { file, isFile: false };
      }
    })
  );

  const filesToMove = fileStats.filter(({ isFile }) => isFile).map(({ file }) => file);

  if (filesToMove.length === 0) {
    console.log(`  ${type}: no files to move`);
    return { moved: 0, skipped: 0, errors: 0 };
  }

  // Ensure destination directory exists
  await fs.mkdir(destDir, { recursive: true });

  let moved = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of filesToMove) {
    const sourcePath = path.join(sourceDir, file);
    const destPath = path.join(destDir, file);

    try {
      const destExists = await fileExists(destPath);
      if (destExists) {
        // Compare file sizes to see if they're the same
        const sourceStat = await fs.stat(sourcePath);
        const destStat = await fs.stat(destPath);

        if (sourceStat.size === destStat.size) {
          console.log(`  ${type}: skipping ${file} (already exists with same size)`);
          // Remove the duplicate from source
          await fs.unlink(sourcePath);
          skipped++;
        } else {
          console.log(`  ${type}: warning - ${file} exists in destination with different size`);
          console.log(`    source: ${sourceStat.size} bytes, dest: ${destStat.size} bytes`);
          console.log(`    keeping destination, removing source`);
          await fs.unlink(sourcePath);
          skipped++;
        }
      } else {
        await fs.rename(sourcePath, destPath);
        console.log(`  ${type}: moved ${file}`);
        moved++;
      }
    } catch (error) {
      console.error(`  ${type}: error moving ${file}:`, error.message);
      errors++;
    }
  }

  return { moved, skipped, errors };
}

async function removeEmptyDir(dirPath) {
  try {
    const files = await fs.readdir(dirPath);
    if (files.length === 0) {
      await fs.rmdir(dirPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function main() {
  console.log('migrating storage directory structure...');
  console.log(`project root: ${projectRoot}`);
  console.log('');

  // Check if old directories exist
  const oldGifsExists = await fileExists(OLD_GIFS_DIR);
  const oldVideosExists = await fileExists(OLD_VIDEOS_DIR);

  if (!oldGifsExists && !oldVideosExists) {
    console.log('no migration needed - old nested directories do not exist');
    return;
  }

  // Move files from data/gifs/gifs to data/gifs
  console.log('moving gifs from data/gifs/gifs to data/gifs...');
  const gifsResult = await moveFiles(OLD_GIFS_DIR, NEW_GIFS_DIR, 'gifs');
  console.log(
    `  result: ${gifsResult.moved} moved, ${gifsResult.skipped} skipped, ${gifsResult.errors} errors`
  );
  console.log('');

  // Move files from data/gifs/videos to data/videos
  console.log('moving videos from data/gifs/videos to data/videos...');
  const videosResult = await moveFiles(OLD_VIDEOS_DIR, NEW_VIDEOS_DIR, 'videos');
  console.log(
    `  result: ${videosResult.moved} moved, ${videosResult.skipped} skipped, ${videosResult.errors} errors`
  );
  console.log('');

  // Try to remove empty nested directories
  if (oldGifsExists) {
    const removed = await removeEmptyDir(OLD_GIFS_DIR);
    if (removed) {
      console.log('removed empty data/gifs/gifs directory');
    }
  }

  if (oldVideosExists) {
    const removed = await removeEmptyDir(OLD_VIDEOS_DIR);
    if (removed) {
      console.log('removed empty data/gifs/videos directory');
    }
  }

  // Try to remove data/gifs if it's now empty (shouldn't happen, but just in case)
  const gifsParentDir = path.join(DATA_DIR, 'gifs');
  try {
    const files = await fs.readdir(gifsParentDir);
    // Check if only 'gifs' and 'videos' subdirs exist (which would be the old nested ones)
    const hasOnlyOldDirs = files.length <= 2 && files.every(f => f === 'gifs' || f === 'videos');

    if (hasOnlyOldDirs) {
      // Check if both are empty or don't exist
      const oldGifsEmpty =
        !(await fileExists(OLD_GIFS_DIR)) || (await fs.readdir(OLD_GIFS_DIR)).length === 0;
      const oldVideosEmpty =
        !(await fileExists(OLD_VIDEOS_DIR)) || (await fs.readdir(OLD_VIDEOS_DIR)).length === 0;

      if (oldGifsEmpty && oldVideosEmpty) {
        // This shouldn't happen, but if it does, we'd need to be careful
        // Actually, we should keep data/gifs since that's where gifs go now
      }
    }
  } catch {
    // Ignore errors checking parent directory
  }

  console.log('');
  console.log('migration complete');
  const totalMoved = gifsResult.moved + videosResult.moved;
  const totalSkipped = gifsResult.skipped + videosResult.skipped;
  const totalErrors = gifsResult.errors + videosResult.errors;
  console.log(`summary: ${totalMoved} files moved, ${totalSkipped} skipped, ${totalErrors} errors`);
}

main().catch(error => {
  console.error('migration failed:', error);
  process.exit(1);
});
