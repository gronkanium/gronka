// Stats auth credentials (optional - only needed if main server requires auth)
const STATS_USERNAME = process.env.STATS_USERNAME || null;
const STATS_PASSWORD = process.env.STATS_PASSWORD || null;

// Build auth header if credentials are provided
export function getAuthHeaders() {
  const headers = {};
  if (STATS_USERNAME && STATS_PASSWORD) {
    const credentials = Buffer.from(`${STATS_USERNAME}:${STATS_PASSWORD}`).toString('base64');
    headers.Authorization = `Basic ${credentials}`;
  }
  return headers;
}
