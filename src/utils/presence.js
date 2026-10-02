import { ActivityType } from 'discord.js';
import { getSetting, setSetting } from './database.js';

export const VALID_PRESENCE_STATUSES = ['online', 'idle', 'dnd', 'invisible'];
export const DEFAULT_PRESENCE_STATUS = 'dnd';

const PRESENCE_STATUS_KEY = 'bot_presence_status';
const PRESENCE_ACTIVITY_KEY = 'bot_presence_activity';

// Discord's own client sends custom statuses as name "Custom Status" with the text in `state`;
// discord.js silently rewrites {name: text, type: Custom} into that shape. Build it explicitly so
// the local ClientPresence reads back the same way it went out.
const CUSTOM_ACTIVITY_NAME = 'Custom Status';

// Build discord.js presence options from a status and custom-status text
export function buildPresenceOptions(status, activity) {
  const options = {};
  if (status) {
    options.status = status;
  }
  if (activity) {
    options.activities = [
      { name: CUSTOM_ACTIVITY_NAME, state: activity, type: ActivityType.Custom },
    ];
  }
  return options;
}

// Read the text a presence activity actually displays
export function activityDisplayText(activity) {
  if (!activity) {
    return null;
  }
  if (activity.type === ActivityType.Custom) {
    return activity.state || null;
  }
  return activity.name || null;
}

export async function loadSavedPresence() {
  let status = await getSetting(PRESENCE_STATUS_KEY, DEFAULT_PRESENCE_STATUS);
  if (!VALID_PRESENCE_STATUSES.includes(status)) {
    status = DEFAULT_PRESENCE_STATUS;
  }
  const activity = (await getSetting(PRESENCE_ACTIVITY_KEY, '')) || '';
  return { status, activity };
}

// Persist a presence so it survives restarts
export async function saveSavedPresence(status, activity) {
  if (status) {
    await setSetting(PRESENCE_STATUS_KEY, status);
  }
  await setSetting(PRESENCE_ACTIVITY_KEY, activity || '');
}
