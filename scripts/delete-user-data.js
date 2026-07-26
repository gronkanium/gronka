#!/usr/bin/env bun

/**
 * Delete all stored data for a single Discord user (data-deletion request handler).
 *
 * Removes, for the given user id:
 *   - users row and user_metrics row
 *   - processed_urls rows (their downloads/conversions/optimizations); the
 *     temporary_uploads FK cascades automatically
 *   - alerts rows referencing the user
 *   - the underlying media files (R2 + local disk), UNLESS the same content hash is
 *     still referenced by another user (files are content-addressed and shared)
 *
 * Deliberately NOT removed:
 *   - banned_users rows (moderation record) unless --include-bans is passed
 *   - the `logs` table (a user id may be buried in free-text metadata; scrub manually
 *     if a request requires it)
 *
 * Dry-run by default: it only reports. Pass --execute to actually delete.
 *
 * Usage:
 *   node scripts/delete-user-data.js --user-id <id> [options]
 *   npm run delete:user-data -- --user-id 123456789012345678
 *   npm run delete:user-data -- --user-id 123456789012345678 --execute
 *
 * Options:
 *   --user-id <id>   Discord user id to delete (required)
 *   --execute        Actually delete. Without this, runs as a dry-run (default).
 *   --yes, -y        Skip the confirmation prompt (implies you've reviewed the report).
 *   --keep-files     Delete DB rows only; leave R2/local media files in place.
 *   --include-bans   Also remove the user's banned_users row (default: keep it).
 *
 * In Docker, run it inside the app container so it sees the same DB/R2 config:
 *   docker compose exec app npm run delete:user-data -- --user-id <id> --execute
 */

import { existsSync, unlinkSync } from 'fs';
import { createInterface } from 'readline';
import postgres from 'postgres';
import { getPostgresConfig } from '../src/utils/database/connection.js';
import { r2Config } from '../src/utils/config.js';
import { getR2KeyFromHash, deleteFromR2 } from '../src/utils/r2-storage.js';
import { getGifPath, getVideoPath, getImagePath } from '../src/utils/storage.js';

const args = process.argv.slice(2);

function getFlagValue(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const userId = getFlagValue('--user-id');
const execute = args.includes('--execute');
const dryRun = !execute;
const skipConfirm = args.includes('--yes') || args.includes('-y');
const keepFiles = args.includes('--keep-files');
const includeBans = args.includes('--include-bans');

// Local storage base path — same default the app/container uses. get*Path() append the
// gifs/ videos/ images/ subdirectory themselves.
const storagePath = process.env.GIF_STORAGE_PATH || './data-prod/gifs';

const line = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

function isR2Configured() {
  return !!(
    r2Config.accountId &&
    r2Config.accessKeyId &&
    r2Config.secretAccessKey &&
    r2Config.bucketName
  );
}

/**
 * Local disk path for a stored file, or null if the type is unknown.
 */
function localPathFor(fileHash, fileType, fileExtension) {
  if (fileType === 'gif') {
    return getGifPath(fileHash, storagePath);
  }
  if (fileType === 'video') {
    return getVideoPath(fileHash, fileExtension, storagePath);
  }
  if (fileType === 'image') {
    return getImagePath(fileHash, fileExtension, storagePath);
  }
  return null;
}

function askConfirmation(question) {
  return new Promise(resolve => {
    if (skipConfirm) {
      resolve(true);
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes');
    });
  });
}

async function main() {
  console.log(line);
  console.log('gronka data deletion');
  console.log(line);

  if (!userId) {
    console.error('\nerror: --user-id <id> is required\n');
    console.error('usage: node scripts/delete-user-data.js --user-id <id> [--execute]');
    process.exit(1);
  }

  if (!/^\d{5,25}$/.test(userId)) {
    console.error(`\nerror: "${userId}" is not a valid discord user id (expected digits only)\n`);
    process.exit(1);
  }

  console.log(`\nuser id: ${userId}`);
  console.log(
    dryRun ? 'mode:    DRY RUN (no changes — pass --execute to delete)' : 'mode:    EXECUTE'
  );
  if (!isR2Configured()) {
    console.log('r2:      not configured (only local files + database rows are considered)');
  }

  const sql = postgres(getPostgresConfig());

  try {
    await sql`SELECT 1`;

    // --- Gather footprint ------------------------------------------------------
    const [userRow] =
      await sql`SELECT username, first_used, last_used FROM users WHERE user_id = ${userId}`;
    const [metricsRow] =
      await sql`SELECT total_commands FROM user_metrics WHERE user_id = ${userId}`;
    const media = await sql`
      SELECT url_hash, file_hash, file_type, file_extension, file_url
      FROM processed_urls
      WHERE user_id = ${userId}
    `;
    const [{ count: alertCount }] = await sql`
      SELECT COUNT(*)::int AS count FROM alerts WHERE user_id = ${userId}
    `;
    const [banRow] = await sql`SELECT reason FROM banned_users WHERE user_id = ${userId}`;

    const nothingFound =
      !userRow && !metricsRow && media.length === 0 && alertCount === 0 && !banRow;
    if (nothingFound) {
      console.log('\nno data found for this user id. nothing to delete.');
      return;
    }

    console.log(`\n${line}`);
    console.log('found:');
    console.log(`  users row:         ${userRow ? `yes (${userRow.username})` : 'none'}`);
    console.log(`  user_metrics row:  ${metricsRow ? 'yes' : 'none'}`);
    console.log(`  media records:     ${media.length}`);
    console.log(`  alerts:            ${alertCount}`);
    console.log(
      `  banned_users row:  ${banRow ? `yes${includeBans ? ' (will remove)' : ' (kept — pass --include-bans to remove)'}` : 'none'}`
    );

    // --- Work out which physical files are safe to delete ----------------------
    // Files are content-addressed: the same hash may back another user's record.
    // Only delete the underlying file when no OTHER user still references that hash.
    const filesToDelete = [];
    const sharedFiles = [];

    if (!keepFiles) {
      for (const row of media) {
        if (!row.file_hash) {
          continue;
        }
        const [{ count: otherRefs }] = await sql`
          SELECT COUNT(*)::int AS count
          FROM processed_urls
          WHERE file_hash = ${row.file_hash}
            AND user_id IS DISTINCT FROM ${userId}
        `;
        if (otherRefs > 0) {
          sharedFiles.push(row);
        } else {
          filesToDelete.push(row);
        }
      }

      console.log(`\n  files to remove:   ${filesToDelete.length}`);
      if (sharedFiles.length > 0) {
        console.log(`  files kept (shared with other users): ${sharedFiles.length}`);
      }
    } else {
      console.log('\n  --keep-files set: media files will be left in place');
    }

    // --- Dry run stops here ----------------------------------------------------
    if (dryRun) {
      console.log(`\n${line}`);
      console.log('[DRY RUN] no changes were made. re-run with --execute to delete.');
      return;
    }

    // --- Confirm ---------------------------------------------------------------
    const confirmed = await askConfirmation(
      `\n⚠️  permanently delete all data for user ${userId}? type "yes" to proceed: `
    );
    if (!confirmed) {
      console.log('\ncancelled. no changes were made.');
      return;
    }

    // --- Delete physical files -------------------------------------------------
    let r2Deleted = 0;
    let localDeleted = 0;
    let fileFailures = 0;

    for (const row of filesToDelete) {
      // R2
      if (isR2Configured()) {
        try {
          const key = getR2KeyFromHash(row.file_hash, row.file_type, row.file_extension);
          if (key && (await deleteFromR2(key, r2Config))) {
            r2Deleted++;
          }
        } catch (error) {
          console.warn(`  warning: r2 delete failed for ${row.file_hash}: ${error.message}`);
          fileFailures++;
        }
      }
      // Local disk
      try {
        const path = localPathFor(row.file_hash, row.file_type, row.file_extension);
        if (path && existsSync(path)) {
          unlinkSync(path);
          localDeleted++;
        }
      } catch (error) {
        console.warn(`  warning: local delete failed for ${row.file_hash}: ${error.message}`);
        fileFailures++;
      }
    }

    // --- Delete database rows --------------------------------------------------
    // processed_urls first so temporary_uploads cascades cleanly.
    const processedDeleted = (await sql`DELETE FROM processed_urls WHERE user_id = ${userId}`)
      .count;
    const metricsDeleted = (await sql`DELETE FROM user_metrics WHERE user_id = ${userId}`).count;
    const alertsDeleted = (await sql`DELETE FROM alerts WHERE user_id = ${userId}`).count;
    const usersDeleted = (await sql`DELETE FROM users WHERE user_id = ${userId}`).count;
    let bansDeleted = 0;
    if (includeBans) {
      bansDeleted = (await sql`DELETE FROM banned_users WHERE user_id = ${userId}`).count;
    }

    // --- Summary ---------------------------------------------------------------
    console.log(`\n${line}`);
    console.log('deletion complete');
    console.log(line);
    console.log(`  processed_urls rows deleted: ${processedDeleted}`);
    console.log(`  user_metrics rows deleted:   ${metricsDeleted}`);
    console.log(`  alerts rows deleted:         ${alertsDeleted}`);
    console.log(`  users rows deleted:          ${usersDeleted}`);
    if (includeBans) {
      console.log(`  banned_users rows deleted:   ${bansDeleted}`);
    }
    if (!keepFiles) {
      console.log(`  r2 objects deleted:          ${r2Deleted}`);
      console.log(`  local files deleted:         ${localDeleted}`);
      if (sharedFiles.length > 0) {
        console.log(`  shared files kept:           ${sharedFiles.length}`);
      }
      if (fileFailures > 0) {
        console.log(`  file deletion failures:      ${fileFailures} (see warnings above)`);
      }
    }
    console.log(`\ndone. user ${userId} data removed.`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch(error => {
  console.error('\n❌ error during deletion:', error);
  process.exit(1);
});
