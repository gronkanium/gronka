// Builds the per-platform landing pages from web/public/index.html: `bun web/pages.mjs`.
// Every claim here must match what the code does (src/utils/download-services.js, src/core, src/web-server.js).
import fs from 'node:fs';

const ROOT = new URL('./public/', import.meta.url);
const SITE = 'https://web.gronka.dev';

const PLATFORMS = [
  {
    slug: 'tiktok',
    name: 'tiktok',
    title: 'tiktok downloader: save tiktok videos',
    desc: 'save a tiktok video or just its sound. paste the link, get the file. free, no ads, no account, no request logs.',
    placeholder: 'paste a tiktok link',
  },
  {
    slug: 'instagram',
    name: 'instagram',
    title: 'instagram downloader: reels, posts, stories',
    desc: 'save instagram reels, photo posts, carousels, stories and highlights. paste the link, get the file. free, no ads, no account.',
    placeholder: 'paste an instagram link',
  },
  {
    slug: 'x',
    name: 'x',
    title: 'x (twitter) video downloader: save videos and gifs',
    desc: 'save videos, gifs and images from x (twitter). works with x.com and twitter.com links. free, no ads, no account, no request logs.',
    placeholder: 'paste an x or twitter link',
  },
  {
    slug: 'youtube',
    name: 'youtube',
    title: 'youtube downloader: videos, shorts and audio',
    desc: 'save a youtube video, a short, or just the audio as an mp3. trim to the part you want. free, no ads, no account, no request logs.',
    placeholder: 'paste a youtube link',
  },
  {
    slug: 'reddit',
    name: 'reddit',
    title: 'reddit video downloader: videos, galleries, gifs',
    desc: 'save reddit videos with sound, whole galleries in order, and gifs from comments. paste the link, get the file. free, no ads.',
    placeholder: 'paste a reddit link',
  },
  {
    slug: 'pinterest',
    name: 'pinterest',
    title: 'pinterest downloader: videos and full-size images',
    desc: 'save pinterest videos and full-size images. pin.it share links work. free, no ads, no account, no request logs.',
    placeholder: 'paste a pinterest link',
  },
  {
    slug: 'facebook',
    name: 'facebook',
    title: 'facebook video downloader',
    desc: 'save facebook videos. fb.watch links work. free, no ads, no account, no request logs.',
    placeholder: 'paste a facebook link',
  },
];

// Every other non-adult source in src/utils/download-services.js gets a plain page; `what` is only what the
// code gets from it. Adult and booru sources stay unlinked text: explicit pages can get the whole domain
// classed as adult by search engines.
const MORE = [
  ['bluesky', 'bluesky', 'videos'],
  ['snapchat', 'snapchat', 'videos'],
  ['tumblr', 'tumblr', 'videos'],
  ['twitch', 'twitch', 'clips'],
  ['soundcloud', 'soundcloud', 'tracks as audio'],
  ['streamable', 'streamable', 'videos'],
  ['dailymotion', 'dailymotion', 'videos'],
  ['imgur', 'imgur', 'videos'],
  ['giphy', 'giphy', 'gifs'],
  ['tenor', 'tenor', 'gifs'],
  ['klipy', 'klipy', 'gifs'],
  ['kick', 'kick', 'videos and clips'],
  ['medal', 'medal', 'clips'],
  ['rumble', 'rumble', 'videos'],
  ['coub', 'coub', 'videos'],
  ['niconico', 'niconico', 'videos'],
  ['bilibili', 'bilibili', 'videos'],
  ['xiaohongshu', 'xiaohongshu', 'videos'],
  ['mega', 'mega', 'files'],
  ['deviantart', 'deviantart', 'images'],
  ['artstation', 'artstation', 'images'],
  ['flickr', 'flickr', 'images'],
  ['wallhaven', 'wallhaven', 'wallpapers'],
  ['mangadex', 'mangadex', 'chapter pages'],
];
for (const [slug, name, what] of MORE) {
  PLATFORMS.push({
    slug,
    name,
    title: `${name} downloader: save ${what}`,
    desc: `save ${what} from ${name}. paste the link, get the file. free, no ads, no account, no request logs.`,
    placeholder: `paste ${/^[aeiox]/.test(name) ? 'an' : 'a'} ${name} link`,
  });
}

const OTHER_SITES = [
  'redgifs',
  'xvideos',
  'xhamster',
  'redtube',
  'rule34video',
  'nhentai',
  'hentaigifz',
  'danbooru',
  'e621',
  'yande.re',
  'konachan',
];

const HOME = {
  title: 'gronka: free video downloader, no ads, no account',
  desc: 'paste a link from tiktok, instagram, x, youtube, reddit and more, get the file. free, no ads, no account, no request logs.',
};

const esc = text =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ld = data => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

const sitesList = current => `<details class="sites">
          <summary>supported sites</summary>
          <ul>${PLATFORMS.map(p =>
            p.slug === current
              ? `<li class="page"><a href="/${p.slug}/" aria-current="page">${p.name}</a></li>`
              : `<li class="page"><a href="/${p.slug}/">${p.name}</a></li>`
          ).join('')}${OTHER_SITES.map(name => `<li>${name}</li>`).join('')}</ul>
          <p class="note">public posts only. gronka isn't affiliated with any of these.</p>
        </details>`;

function withHead(html, { title, desc, url, jsonld }) {
  const swap = (pattern, text) => {
    if (!pattern.test(html)) throw new Error(`template lost ${pattern}`);
    html = html.replace(pattern, text);
  };
  swap(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  swap(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
    `<meta name="description" content="${esc(desc)}" />`
  );
  swap(/<link\s+rel="canonical"\s+href="[^"]*"\s*\/>/, `<link rel="canonical" href="${url}" />`);
  swap(
    /<meta\s+property="og:url"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:url" content="${url}" />`
  );
  swap(
    /<meta\s+property="og:title"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:title" content="${esc(title)}" />`
  );
  swap(
    /<meta\s+property="og:description"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:description" content="${esc(desc)}" />`
  );
  html = html.replace(/\s*<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
  return html.replace(
    '</head>',
    `    ${ld({ '@context': 'https://schema.org', '@graph': jsonld })}\n  </head>`
  );
}

function withSites(html, current) {
  html = html.replace(/\s*<section class="more">[\s\S]*?<\/section>/, '');
  html = html.replace(/\s*<details class="sites">[\s\S]*?<\/details>/, '');
  // Below the result panel, so it never sits between the link and the answer.
  const panel = /(<section id="panel"[^>]*><\/section>(?:\s*<div id="ts-slot"><\/div>)?)/;
  if (!panel.test(html)) throw new Error('template lost the panel');
  return html.replace(panel, `$1\n\n      ${sitesList(current)}`);
}

const app = {
  '@type': 'WebApplication',
  name: 'gronka',
  url: `${SITE}/`,
  applicationCategory: 'MultimediaApplication',
  operatingSystem: 'any',
  browserRequirements: 'requires javascript',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
};

// Clear the last build's output (listed in .gitignore) so a dropped source's page doesn't linger.
const IGNORE = new URL('.gitignore', import.meta.url);
if (fs.existsSync(IGNORE)) {
  for (const line of fs.readFileSync(IGNORE, 'utf8').split('\n')) {
    if (line.startsWith('public/'))
      fs.rmSync(new URL(line, import.meta.url), { recursive: true, force: true });
  }
}

let home = fs.readFileSync(new URL('index.html', ROOT), 'utf8');
home = withHead(home, {
  title: HOME.title,
  desc: HOME.desc,
  url: `${SITE}/`,
  jsonld: [app],
});
home = withSites(home, null);
fs.writeFileSync(new URL('index.html', ROOT), home);

for (const p of PLATFORMS) {
  const url = `${SITE}/${p.slug}/`;
  let page = withHead(home, {
    title: `${p.title} | gronka`,
    desc: p.desc,
    url,
    jsonld: [
      { ...app, url },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'gronka', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: `${p.name} downloader`, item: url },
        ],
      },
    ],
  });
  const swaps = [
    [
      /<h1>[\s\S]*?<\/h1>/,
      `<h1>paste ${/^[aeiox]/.test(p.name) ? 'an' : 'a'} ${esc(p.name)} link, get the file.</h1>`,
    ],
    [/placeholder="paste a link"/, `placeholder="${esc(p.placeholder)}"`],
  ];
  for (const [pattern, text] of swaps) {
    if (!pattern.test(page)) throw new Error(`template lost ${pattern}`);
    page = page.replace(pattern, text);
  }
  page = withSites(page, p.slug);
  fs.mkdirSync(new URL(`${p.slug}/`, ROOT), { recursive: true });
  fs.writeFileSync(new URL(`${p.slug}/index.html`, ROOT), page);
}

const urls = ['', ...PLATFORMS.map(p => `${p.slug}/`), 'docs/', 'terms/', 'privacy/'];
fs.writeFileSync(
  new URL('sitemap.xml', ROOT),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map(u => `  <url><loc>${SITE}/${u}</loc></url>`)
    .join('\n')}\n</urlset>\n`
);
fs.writeFileSync(
  new URL('robots.txt', ROOT),
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`
);
// Everything written here except index.html is build output, rebuilt by `wrangler deploy` (wrangler.toml).
fs.writeFileSync(
  IGNORE,
  [
    '# written by pages.mjs',
    'public/sitemap.xml',
    'public/robots.txt',
    ...PLATFORMS.map(p => `public/${p.slug}/`),
  ].join('\n') + '\n'
);
console.log(`home + ${PLATFORMS.length} pages, sitemap ${urls.length} urls`);
