import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Configuration
const BOT_API_URL = process.env.BOT_API_URL || 'http://localhost:3000';
const STATS_USERNAME = process.env.STATS_USERNAME || '';
const STATS_PASSWORD = process.env.STATS_PASSWORD || '';
const DATA_DIR = path.join(projectRoot, '_data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

/**
 * Get authentication headers if credentials are configured
 * @returns {Object} Headers object with Authorization if configured
 */
function getAuthHeaders() {
  const headers = {};
  if (STATS_USERNAME && STATS_PASSWORD) {
    const credentials = Buffer.from(`${STATS_USERNAME}:${STATS_PASSWORD}`).toString('base64');
    headers.Authorization = `Basic ${credentials}`;
  }
  return headers;
}

/**
 * Fetch stats from bot API
 * @returns {Promise<Object>} Stats object
 */
async function fetchStats() {
  const url = `${BOT_API_URL}/api/stats/24h`;
  const headers = getAuthHeaders();

  try {
    console.log(`Fetching stats from ${url}...`);
    const response = await axios.get(url, {
      headers,
      timeout: 10000, // 10 second timeout
    });

    if (response.data && response.status === 200) {
      return response.data;
    }

    throw new Error(`Unexpected response: ${response.status}`);
  } catch (error) {
    if (error.response) {
      // Server responded with error status
      throw new Error(
        `API request failed: ${error.response.status} ${error.response.statusText} - ${error.response.data?.message || error.response.data?.error || 'Unknown error'}`
      );
    } else if (error.request) {
      // Request made but no response
      throw new Error(`No response from API at ${url}. Is the bot server running?`);
    } else {
      // Error setting up request
      throw new Error(`Request setup failed: ${error.message}`);
    }
  }
}

/**
 * Write stats to JSON file
 * @param {Object} stats - Stats object to write
 * @returns {Promise<void>}
 */
async function writeStatsFile(stats) {
  try {
    // Ensure _data directory exists
    await fs.mkdir(DATA_DIR, { recursive: true });

    // Write stats to file
    const jsonContent = JSON.stringify(stats, null, 2);
    await fs.writeFile(STATS_FILE, jsonContent, 'utf8');
    console.log(`Stats written to ${STATS_FILE}`);
  } catch (error) {
    throw new Error(`Failed to write stats file: ${error.message}`);
  }
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('Updating Jekyll stats...');
    const stats = await fetchStats();
    await writeStatsFile(stats);
    console.log('Stats updated successfully!');
    console.log(`  - Unique users: ${stats.unique_users}`);
    console.log(`  - Total files: ${stats.total_files}`);
    console.log(`  - Total data: ${stats.total_data_formatted}`);
    process.exit(0);
  } catch (error) {
    console.error('Error updating stats:', error.message);
    process.exit(1);
  }
}

// Run the script
main();

export { fetchStats, writeStatsFile };
