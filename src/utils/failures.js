import { createLogger } from './logger.js';
import { insertAlert } from './database.js';
import { hostOf } from './url-host.js';

const logger = createLogger('failures');

// A link in an error message is cut to its host, the same as the request's own link.
const hostsOnly = text =>
  text?.replace(/https?:\/\/[^\s"'<>)]+/gi, url => hostOf(url) ?? '<link>') ?? null;

// The one record a failed request leaves: which command, which site, what went wrong. Never who
// asked or the exact link.
export async function recordFailure(
  command,
  { error = null, errorClass = null, url = null, cause = null } = {}
) {
  const reason = hostsOnly(error);
  const underlying = hostsOnly(cause?.message);
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
        cause: underlying && underlying !== reason ? underlying : null,
        source: hostOf(url) ?? null,
      },
    });
  } catch (error_) {
    logger.error(`Could not record a ${command} failure: ${error_.message}`);
  }
}
