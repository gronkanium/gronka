/* eslint-env cloudflare */
/**
 * Cloudflare Pages Function to serve 24-hour stats from KV
 *
 * This function reads stats from Cloudflare KV and returns them as JSON.
 * The KV namespace should be bound to this Pages project as KV_BINDING.
 *
 * @param {Request} _request - The incoming request (unused)
 * @param {Object} env - Environment variables and bindings (includes KV_BINDING)
 * @returns {Response} JSON response with stats or error
 */
export async function onRequestGet({ request: _request, env }) {
  try {
    // Get KV namespace binding
    // Check for both possible binding names (KV_BINDING or STATS_KV)
    const kv = env.KV_BINDING || env.STATS_KV;
    if (!kv) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'KV namespace not configured',
          message:
            'KV namespace binding not found. Please configure KV_BINDING in Cloudflare Pages project settings.',
          availableEnvKeys: Object.keys(env).filter(
            key => key.includes('KV') || key.includes('BINDING')
          ),
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        }
      );
    }

    // Read stats from KV
    const kvKey = 'stats:24h';
    let kvData;
    try {
      const kvValue = await kv.get(kvKey, 'json');
      if (!kvValue) {
        // No data in KV, return zeros
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              total_conversions: 0,
              total_size_bytes: 0,
              total_size_formatted: '0 B',
              unique_users: 0,
              by_type: { gif: 0, video: 0, image: 0 },
            },
            updated_at: Date.now(),
            status: 'unavailable',
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type',
            },
          }
        );
      }
      kvData = kvValue;
    } catch (error) {
      // KV read error, return error response
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Failed to read stats from storage',
          message: error.message,
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        }
      );
    }

    // Validate and return data
    if (kvData && kvData.success && kvData.data) {
      return new Response(JSON.stringify(kvData), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Cache-Control': 'public, max-age=300', // Cache for 5 minutes
        },
      });
    } else {
      // Invalid data format
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Invalid data format in storage',
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        }
      );
    }
  } catch (error) {
    // Unexpected error
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Internal server error',
        message: error.message,
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      }
    );
  }
}

/**
 * Handle OPTIONS request for CORS preflight
 */
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400', // 24 hours
    },
  });
}
