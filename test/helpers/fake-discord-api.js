// A stand-in for the Discord REST routes a worker uses, recording every call.
let nextId = 1000;

const message = (channelId, body = {}, files = []) => ({
  id: String(nextId++),
  channel_id: channelId,
  type: 0,
  content: body.content ?? '',
  author: { id: '1', username: 'gronka', discriminator: '0', avatar: null },
  timestamp: new Date().toISOString(),
  edited_timestamp: null,
  tts: false,
  pinned: false,
  mention_everyone: false,
  mentions: [],
  mention_roles: [],
  embeds: [],
  components: [],
  attachments: files.map((file, i) => ({
    id: String(nextId++),
    filename: file.name,
    size: file.size,
    url: `https://cdn.discordapp.com/attachments/${channelId}/${i}/${file.name}`,
    proxy_url: `https://media.discordapp.net/attachments/${channelId}/${i}/${file.name}`,
  })),
});

async function readBody(request) {
  const type = request.headers.get('content-type') ?? '';
  if (type.startsWith('multipart/form-data')) {
    const form = await request.formData();
    const files = [];
    for (const [key, value] of form.entries()) {
      if (key !== 'payload_json' && typeof value !== 'string') {
        files.push({ name: value.name, size: value.size });
      }
    }
    return { body: JSON.parse(form.get('payload_json') ?? '{}'), files };
  }
  const text = await request.text();
  return { body: text ? JSON.parse(text) : {}, files: [] };
}

export function startFakeDiscordApi() {
  const calls = [];
  const failures = new Map();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const path = pathname.replace(/^\/api\/v\d+/, '');
      const { body, files } = await readBody(request);
      calls.push({ method: request.method, path, body, files });
      const failurePath = decodeURIComponent(path);
      const failure = failures.get(failurePath);
      if (failure) {
        failures.delete(failurePath);
        return Response.json(
          { message: 'rejected', code: failure.code },
          { status: failure.status }
        );
      }
      let match;
      if (/^\/webhooks\/[^/]+\/[^/]+(?:\/messages\/.+)?$/.test(path)) {
        return Response.json(message('900', body, files));
      }
      if ((match = path.match(/^\/channels\/(\d+)$/))) {
        return Response.json({
          id: match[1],
          type: 0,
          guild_id: '555',
          name: 'general',
          position: 0,
          permission_overwrites: [],
        });
      }
      if ((match = path.match(/^\/channels\/(\d+)\/messages(?:\/(\d+))?$/))) {
        const reply = message(match[1], body, files);
        if (match[2]) reply.id = match[2];
        return Response.json(reply);
      }
      return new Response('{"message":"not found"}', { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/api`,
    calls,
    failures,
    stop: () => server.stop(true),
  };
}
