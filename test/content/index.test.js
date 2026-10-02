import { test, expect } from 'bun:test';
import { CONTENT_SOURCES, fetchContent } from '../../src/content/index.js';

test('the same link and options within a minute are answered without asking the source again', async () => {
  let calls = 0;
  const fake = {
    id: 'fake',
    label: 'Fake',
    hosts: ['fake.example'],
    match: url => url.startsWith('https://fake.example/'),
    fetch: async () => ({ calls: ++calls }),
  };
  CONTENT_SOURCES.unshift(fake);
  try {
    const url = `https://fake.example/${Date.now()}`;
    expect(await fetchContent(url, {})).toEqual({ calls: 1 });
    expect(await fetchContent(url, {})).toEqual({ calls: 1 });
    expect(await fetchContent(url, { comments: 5 })).toEqual({ calls: 2 });
  } finally {
    CONTENT_SOURCES.splice(CONTENT_SOURCES.indexOf(fake), 1);
  }
});
