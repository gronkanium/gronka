#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { r2Config, serverConfig } from '../src/utils/config.js';
import { uploadGifToR2, gifExistsInR2 } from '../src/utils/r2-storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Rate limiting configuration
const CHECK_DELAY_MS = parseInt(process.env.MIGRATE_CHECK_DELAY_MS || '500', 10); // Delay after checking if file exists
const UPLOAD_DELAY_MS = parseInt(process.env.MIGRATE_UPLOAD_DELAY_MS || '1000', 10); // Delay after uploading
const RATE_LIMIT_RETRY_DELAY_MS = parseInt(
  process.env.MIGRATE_RATE_LIMIT_RETRY_DELAY_MS || '5000',
  10
); // Delay on rate limit errors

function getStoragePath(storagePath) {
  if (path.isAbsolute(storagePath)) {
    return storagePath;
  }
  return path.resolve(projectRoot, storagePath);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function migrateGifsToR2() {
  try {
    console.log('migrating gifs to r2...');
    console.log('');

    // Check if R2 config is set
    if (
      !r2Config.accountId ||
      !r2Config.accessKeyId ||
      !r2Config.secretAccessKey ||
      !r2Config.bucketName
    ) {
      console.error('error: r2 credentials not configured in .env file');
      console.error(
        'please set: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME'
      );
      process.exit(1);
    }

    // Get the gifs directory path
    // serverConfig.gifStoragePath may be the base path (./data-prod) or already include gifs (./data-prod/gifs)
    // Check if it already ends with 'gifs' to handle both cases
    const storagePath = getStoragePath(serverConfig.gifStoragePath);
    const gifsDir =
      storagePath.endsWith('gifs') || storagePath.endsWith('gifs/')
        ? storagePath
        : path.join(storagePath, 'gifs');

    // Check if gifs directory exists
    if (!(await fileExists(gifsDir))) {
      console.log(`gifs directory does not exist: ${gifsDir}`);
      console.log('no migration needed');
      return;
    }

    // Read all files in the gifs directory
    let files;
    try {
      files = await fs.readdir(gifsDir);
    } catch (error) {
      console.error(`error reading gifs directory: ${error.message}`);
      process.exit(1);
    }

    // Filter for .gif files only
    const gifFiles = files.filter(file => file.toLowerCase().endsWith('.gif'));

    if (gifFiles.length === 0) {
      console.log('no gif files found in gifs directory');
      return;
    }

    console.log(`found ${gifFiles.length} gif file(s) to migrate`);
    console.log(`gifs directory: ${gifsDir}`);
    console.log(`r2 bucket: ${r2Config.bucketName}`);
    console.log(`r2 public domain: ${r2Config.publicDomain}`);
    console.log(
      `rate limiting: ${CHECK_DELAY_MS}ms after checks, ${UPLOAD_DELAY_MS}ms after uploads`
    );
    console.log('');
    console.log('starting migration...');
    console.log('');

    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    // Process each gif file
    for (let i = 0; i < gifFiles.length; i++) {
      const file = gifFiles[i];
      const filePath = path.join(gifsDir, file);

      // Extract hash from filename (remove .gif extension)
      const hash = file.replace(/\.gif$/i, '');

      // Validate hash format (should be hex characters)
      if (!/^[a-f0-9]+$/i.test(hash)) {
        console.log(`  [${i + 1}/${gifFiles.length}] skipping ${file} (invalid hash format)`);
        skipped++;
        continue;
      }

      try {
        // Check if file exists in R2
        const existsInR2 = await gifExistsInR2(hash, r2Config);
        if (existsInR2) {
          console.log(`  [${i + 1}/${gifFiles.length}] skipping ${file} (already exists in r2)`);
          skipped++;
          // Small delay even for skipped files to avoid rate limiting
          if (CHECK_DELAY_MS > 0 && i < gifFiles.length - 1) {
            await sleep(CHECK_DELAY_MS);
          }
          continue;
        }

        // Small delay after check to avoid rate limiting
        if (CHECK_DELAY_MS > 0) {
          await sleep(CHECK_DELAY_MS);
        }

        // Read file buffer
        const buffer = await fs.readFile(filePath);
        const fileSizeMB = (buffer.length / (1024 * 1024)).toFixed(2);

        // Upload to R2 with retry on rate limit errors
        console.log(`  [${i + 1}/${gifFiles.length}] uploading ${file} (${fileSizeMB} MB)...`);
        let publicUrl;
        let retries = 0;
        const maxRetries = 3;

        while (retries <= maxRetries) {
          try {
            publicUrl = await uploadGifToR2(buffer, hash, r2Config);
            break;
          } catch (error) {
            // Check if it's a rate limit error
            const isRateLimit =
              error.$metadata?.httpStatusCode === 429 ||
              error.message?.toLowerCase().includes('rate limit') ||
              error.message?.toLowerCase().includes('too many requests') ||
              error.name === 'TooManyRequestsException';

            if (isRateLimit && retries < maxRetries) {
              retries++;
              const delay = RATE_LIMIT_RETRY_DELAY_MS * retries; // Exponential backoff
              console.log(
                `    ⚠ rate limited, retrying in ${delay}ms (attempt ${retries}/${maxRetries})...`
              );
              await sleep(delay);
            } else {
              throw error;
            }
          }
        }

        console.log(`    ✓ uploaded: ${publicUrl}`);
        uploaded++;

        // Delay after upload to avoid rate limiting
        if (UPLOAD_DELAY_MS > 0 && i < gifFiles.length - 1) {
          await sleep(UPLOAD_DELAY_MS);
        }
      } catch (error) {
        console.error(`  [${i + 1}/${gifFiles.length}] error processing ${file}:`, error.message);
        failed++;
        errors.push({ file, error: error.message });
        // Small delay even on errors to avoid compounding rate limit issues
        if (CHECK_DELAY_MS > 0 && i < gifFiles.length - 1) {
          await sleep(CHECK_DELAY_MS);
        }
      }
    }

    // Print summary
    console.log('');
    console.log('migration complete');
    console.log(`  uploaded: ${uploaded}`);
    console.log(`  skipped: ${skipped}`);
    console.log(`  failed: ${failed}`);

    if (errors.length > 0) {
      console.log('');
      console.log('errors:');
      errors.forEach(({ file, error }) => {
        console.log(`  ${file}: ${error}`);
      });
    }

    console.log('');
    console.log('note: local files were not deleted (kept as backup)');
  } catch (error) {
    console.error('migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

migrateGifsToR2();
