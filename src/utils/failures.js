import { createLogger, logRef } from './logger.js';
import { insertAlert } from './database.js';
import { hostOf, hostsOnly } from './url-host.js';
import { describeCause, rootCause } from './errors.js';

const logger = createLogger('failures');

// The one record a failed request leaves: which command, what the user was told, the real cause,
// every extractor tried (error.trail), the full link and the non-identifying options. Never who
// asked, and nothing at all for a request that worked.
export async function recordFailure(
  command,
  { error = null, errorClass = null, url = null, cause = null, options = null } = {}
) {
  const reason = hostsOnly(error);
  const underlying = describeCause(rootCause(cause));
  const kept = Object.entries(options ?? {}).filter(([, v]) => v != null && v !== false);
  try {
    await insertAlert({
      severity: 'error',
      component: 'bot',
      title: 'command failed',
      message: reason ? `${command} failed - ${reason}` : `${command} failed`,
      metadata: {
        command,
        error: reason,
        errorClass,
        code: cause?.code ?? null,
        cause: underlying && underlying !== error ? underlying : null,
        source: hostOf(url) ?? null,
        ref: logRef(),
        url: url ?? null,
        trail: cause?.trail?.length ? cause.trail : null,
        options: kept.length ? Object.fromEntries(kept) : null,
      },
    });
  } catch (error_) {
    logger.error(`Could not record a ${command} failure: ${error_.message}`);
  }
}
