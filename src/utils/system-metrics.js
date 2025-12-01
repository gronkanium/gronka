/**
 * System metrics collector for monitoring system health
 * Collects CPU, memory, and disk usage
 */

import os from 'os';
import { promisify } from 'util';
import { exec } from 'child_process';
import { insertSystemMetrics } from './database.js';
import { createLogger } from './logger.js';

const execAsync = promisify(exec);
const logger = createLogger('system-metrics');

let metricsInterval = null;
let broadcastCallback = null;

/**
 * Get CPU usage percentage
 * @returns {Promise<number>} CPU usage percentage (0-100)
 */
async function getCpuUsage() {
  try {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const usage = 100 - ~~((100 * idle) / total);

    return Math.max(0, Math.min(100, usage));
  } catch (error) {
    logger.error('Failed to get CPU usage:', error);
    return null;
  }
}

/**
 * Get memory usage in bytes and percentage
 * @returns {Object} Memory usage info
 */
function getMemoryUsage() {
  try {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;

    return {
      used: usedMemory,
      total: totalMemory,
      percentage: (usedMemory / totalMemory) * 100,
    };
  } catch (error) {
    logger.error('Failed to get memory usage:', error);
    return null;
  }
}

/**
 * Get disk usage (platform-specific)
 * @returns {Promise<Object>} Disk usage info
 */
async function getDiskUsage() {
  try {
    const platform = os.platform();
    let command;

    if (platform === 'win32') {
      // Windows: use wmic or Get-PSDrive
      command = 'powershell "Get-PSDrive C | Select-Object Used,Free"';
    } else {
      // Unix-like: use df
      command = 'df -k / | tail -1';
    }

    const { stdout } = await execAsync(command);

    if (platform === 'win32') {
      // Parse PowerShell output
      const lines = stdout.trim().split('\n');
      if (lines.length >= 3) {
        const dataLine = lines[2].trim().split(/\s+/);
        const used = parseInt(dataLine[0], 10);
        const free = parseInt(dataLine[1], 10);
        const total = used + free;

        return {
          used,
          total,
          percentage: (used / total) * 100,
        };
      }
    } else {
      // Parse df output
      const parts = stdout.trim().split(/\s+/);
      if (parts.length >= 5) {
        const total = parseInt(parts[1], 10) * 1024; // Convert KB to bytes
        const used = parseInt(parts[2], 10) * 1024;

        return {
          used,
          total,
          percentage: (used / total) * 100,
        };
      }
    }

    return null;
  } catch (error) {
    logger.error('Failed to get disk usage:', error);
    return null;
  }
}

/**
 * Get process-specific metrics
 * @returns {Object} Process metrics
 */
function getProcessMetrics() {
  try {
    const memUsage = process.memoryUsage();
    const uptime = process.uptime();

    return {
      uptime: Math.floor(uptime),
      memory: memUsage.heapUsed,
      memoryTotal: memUsage.heapTotal,
      rss: memUsage.rss,
      external: memUsage.external,
    };
  } catch (error) {
    logger.error('Failed to get process metrics:', error);
    return null;
  }
}

/**
 * Collect all system metrics
 * @returns {Promise<Object>} System metrics
 */
export async function collectSystemMetrics() {
  try {
    const cpuUsage = await getCpuUsage();
    const memoryUsage = getMemoryUsage();
    const diskUsage = await getDiskUsage();
    const processMetrics = getProcessMetrics();

    const metrics = {
      cpuUsage: cpuUsage,
      memoryUsage: memoryUsage ? memoryUsage.used : null,
      memoryTotal: memoryUsage ? memoryUsage.total : null,
      diskUsage: diskUsage ? diskUsage.used : null,
      diskTotal: diskUsage ? diskUsage.total : null,
      processUptime: processMetrics ? processMetrics.uptime : null,
      processMemory: processMetrics ? processMetrics.memory : null,
      metadata: {
        memoryPercentage: memoryUsage ? memoryUsage.percentage : null,
        diskPercentage: diskUsage ? diskUsage.percentage : null,
        processMemoryTotal: processMetrics ? processMetrics.memoryTotal : null,
        processRss: processMetrics ? processMetrics.rss : null,
      },
    };

    return metrics;
  } catch (error) {
    logger.error('Failed to collect system metrics:', error);
    return null;
  }
}

/**
 * Set broadcast callback for system metrics updates
 * @param {Function} callback - Callback function to broadcast metrics
 */
export function setBroadcastCallback(callback) {
  broadcastCallback = callback;
}

/**
 * Collect and store system metrics in database
 * @returns {Promise<void>}
 */
export async function collectAndStoreMetrics() {
  try {
    const metrics = await collectSystemMetrics();
    if (metrics) {
      await insertSystemMetrics(metrics);
      logger.debug('System metrics collected and stored');

      // Broadcast metrics update if callback is set
      if (broadcastCallback) {
        try {
          broadcastCallback(metrics);
        } catch (error) {
          logger.error('Error broadcasting system metrics:', error);
        }
      }
    }
  } catch (error) {
    logger.error('Failed to collect and store metrics:', error);
  }
}

/**
 * Start periodic metrics collection
 * @param {number} intervalMs - Collection interval in milliseconds (default: 60000 = 1 minute)
 * @returns {void}
 */
export function startMetricsCollection(intervalMs = 60000) {
  if (metricsInterval) {
    logger.warn('Metrics collection already running');
    return;
  }

  logger.info(`Starting system metrics collection (interval: ${intervalMs}ms)`);

  // Collect immediately
  collectAndStoreMetrics();

  // Then collect periodically
  metricsInterval = setInterval(collectAndStoreMetrics, intervalMs);
}

/**
 * Stop periodic metrics collection
 * @returns {void}
 */
export function stopMetricsCollection() {
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
    logger.info('Stopped system metrics collection');
  }
}

/**
 * Format bytes to human-readable format
 * @param {number} bytes - Bytes
 * @returns {string} Formatted string
 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return 'N/A';
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Format percentage to 2 decimal places
 * @param {number} value - Percentage value
 * @returns {string} Formatted string
 */
export function formatPercentage(value) {
  if (value === null || value === undefined) return 'N/A';
  return `${value.toFixed(2)}%`;
}
