import { isOpen } from './issues.js';

// What each sidebar entry's flyout offers: { open, groups: [{ name, items: [{ label, count, page, params }] }], footer }.
const short = (text, n = 42) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const saved = (views, page) =>
  views
    .filter(v => v.page === page)
    .map(v => ({ label: v.name, page, params: v.params, icon: 'star', removable: v.name }));
const top = (facet = [], n = 3) => facet.slice(0, n);
const count = (facet = [], value) => facet.find(f => f.value === value)?.count;

export function menuFor(page, stats, views, issueStates = {}) {
  const req = stats?.requests;
  const logs = stats?.logs ?? {};
  const issues = (stats?.issues ?? []).filter(g => isOpen(g, issueStates));

  switch (page) {
    case 'requests':
      return {
        open: 'Open requests',
        groups: [
          {
            name: 'Views, last 24h',
            items: [
              { label: 'All requests', count: req?.total, page, params: {}, icon: 'list' },
              {
                label: 'Failed',
                count: req?.failed,
                page,
                params: { status: 'error' },
                icon: 'alert',
              },
              {
                label: 'Slower than 10 s',
                count: req?.slow,
                page,
                params: { minDuration: '10000' },
                icon: 'clock',
              },
            ],
          },
          {
            name: 'By command',
            items: ['download', 'convert', 'optimize'].map(type => ({
              label: `/${type}`,
              count: req?.byType?.[type] ?? 0,
              page,
              params: { type },
              icon: 'slash',
            })),
          },
          ...(saved(views, page).length
            ? [{ name: 'Saved views', items: saved(views, page) }]
            : []),
        ],
      };
    case 'issues':
      return {
        open: 'Open issues',
        groups: [
          {
            name: 'Views',
            items: [
              { label: 'Open', count: issues.length, page, params: {}, icon: 'alert' },
              {
                label: 'Defects',
                count: issues.filter(i => i.kind === 'defect').length,
                page,
                params: { tab: 'defects' },
                icon: 'bug',
              },
              {
                label: 'Upstream',
                count: issues.filter(i => i.kind === 'upstream').length,
                page,
                params: { tab: 'upstream' },
                icon: 'arrow',
              },
              {
                label: 'User errors',
                count: issues.filter(i => i.kind === 'user').length,
                page,
                params: { tab: 'user' },
                icon: 'user',
              },
              { label: 'Muted and resolved', page, params: { tab: 'muted' }, icon: 'dot' },
            ],
          },
          ...(issues.length
            ? [
                {
                  name: 'Top causes',
                  items: issues.slice(0, 3).map(i => ({
                    label: short(i.title),
                    count: i.count,
                    page,
                    params: { issue: i.key },
                    icon: 'dot',
                  })),
                },
              ]
            : []),
        ],
      };
    case 'logs': {
      const sources = top(logs.source);
      const bySource = sources.length
        ? { name: 'By source', key: 'source', list: sources }
        : { name: 'By component', key: 'component', list: top(logs.component) };
      const total = (logs.level ?? []).reduce((sum, f) => sum + f.count, 0);
      return {
        open: 'Open explorer',
        footer: 'Save any filtered view from the explorer to pin it here',
        groups: [
          {
            name: 'Views',
            items: [
              { label: 'Explorer', count: total || undefined, page, params: {}, icon: 'list' },
              { label: 'Live tail', page, params: { live: '1' }, icon: 'live' },
            ],
          },
          {
            name: 'Saved views',
            items: [
              {
                label: 'Errors, last 24h',
                count: count(logs.level, 'ERROR'),
                page,
                params: { level: 'ERROR', range: '24h' },
                icon: 'star',
              },
              {
                label: 'Errors and warnings, last hour',
                page,
                params: { level: 'ERROR,WARN', range: '1h' },
                icon: 'star',
              },
              ...saved(views, page),
            ],
          },
          {
            name: bySource.name,
            items: bySource.list.map(f => ({
              label: f.value,
              count: f.count,
              page,
              params: { [bySource.key]: f.value },
              icon: 'arrow',
            })),
          },
        ],
      };
    }
    case 'users':
      return {
        open: 'Open users',
        groups: [
          {
            name: 'Views',
            items: [
              { label: 'All users', count: stats?.users, page, params: {}, icon: 'list' },
              { label: 'Banned users', page: 'moderation', params: { tab: 'bans' }, icon: 'ban' },
            ],
          },
        ],
      };
    case 'moderation':
      return {
        open: 'Open moderation',
        groups: [
          {
            name: 'Views',
            items: [
              { label: 'Stored files by user', page, params: {}, icon: 'list' },
              { label: 'Bans', page, params: { tab: 'bans' }, icon: 'ban' },
            ],
          },
        ],
      };
    case 'system':
      return {
        open: 'Open workers & queue',
        groups: [
          {
            name: 'Views',
            items: [
              { label: 'Workers & jobs', page, params: {}, icon: 'list' },
              { label: 'Failed jobs', page, params: { status: 'failed' }, icon: 'alert' },
            ],
          },
        ],
      };
    case 'settings':
      return {
        open: 'Open settings',
        groups: [
          {
            name: 'Sections',
            items: [
              ...[
                ['delivery', 'Delivery'],
                ['storage', 'Limits and storage'],
                ['access', 'Access and moderation'],
                ['notifications', 'Notifications'],
                ['presence', 'Bot presence'],
              ].map(([section, label]) => ({ label, page, params: { section }, icon: 'dot' })),
              { label: 'Download sources', page: 'sources', params: {}, icon: 'arrow' },
            ],
          },
        ],
      };
    default:
      return null;
  }
}
