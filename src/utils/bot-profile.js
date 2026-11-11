import { ValidationError } from './errors.js';

const IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

// Sizes, lengths and rate limits are Discord's to enforce; its refusal is passed back as is.
export function parseProfileEdit(body = {}) {
  const user = {};
  if (body.username !== undefined) {
    if (typeof body.username !== 'string' || !body.username.trim()) {
      throw new ValidationError('username must be text');
    }
    user.username = body.username.trim();
  }
  for (const key of ['avatar', 'banner']) {
    if (body[key] === undefined) continue;
    if (body[key] !== null && !(typeof body[key] === 'string' && IMAGE.test(body[key]))) {
      throw new ValidationError(`${key} must be a png, jpeg, gif or webp image`);
    }
    user[key] = body[key];
  }
  if (body.bio !== undefined && typeof body.bio !== 'string') {
    throw new ValidationError('bio must be text');
  }
  if (!Object.keys(user).length && body.bio === undefined) {
    throw new ValidationError('nothing to change');
  }
  return { user, bio: body.bio };
}
