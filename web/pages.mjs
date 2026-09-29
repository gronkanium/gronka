// Builds the per-platform landing pages from web/public/index.html: `bun web/pages.mjs`.
// Every claim here must match what the code does (src/utils/download-services.js, src/core, src/web-server.js).
import fs from 'node:fs';

const ROOT = new URL('./public/', import.meta.url);
const SITE = 'https://web.gronka.dev';

const shared = {
  free: [
    'do i need an account?',
    'no. paste the link and download. accounts only exist to hold api keys.',
  ],
  private: [
    'can it get private posts?',
    'no. a private post or account has nothing public to fetch, so gronka cannot get it.',
  ],
  limits: [
    'is there a limit?',
    'about 10 downloads per 10 minutes, one at a time. the same for everyone, and nothing is paid.',
  ],
  logs: [
    'does gronka keep what i download?',
    'no request logs and no history. files gronka has to copy itself are deleted after an hour.',
  ],
};

const PLATFORMS = [
  {
    slug: 'tiktok',
    name: 'tiktok',
    title: 'tiktok downloader: save tiktok videos',
    desc: 'save a tiktok video or just its sound. paste the link, get the file. free, no ads, no account, no request logs.',
    lede: 'paste a tiktok link, get the video. or just the sound, or the video without it.',
    placeholder: 'paste a tiktok link',
    works: [
      'video links from the app or the site, including <code>vm.tiktok.com</code> share links.',
      'pick <strong>audio</strong> for an mp3 of the sound, or <strong>no sound</strong> for the video on its own.',
      'trim cuts a part out of a longer video.',
    ],
    how: 'gronka asks for the video one way and, if that fails, tries a second way. the second way is also the one that can reach age-restricted posts.',
    faq: [
      [
        'why do some tiktoks take longer?',
        'when the first way fails gronka tries the second, and that adds a few seconds.',
      ],
      shared.free,
      shared.limits,
    ],
  },
  {
    slug: 'instagram',
    name: 'instagram',
    title: 'instagram downloader: reels, posts, stories',
    desc: 'save instagram reels, photo posts, carousels, stories and highlights. paste the link, get the file. free, no ads, no account.',
    lede: 'reels, photo posts, carousels, stories and highlights. paste the link, get the file.',
    placeholder: 'paste an instagram link',
    works: [
      'reels and video posts (<code>/reel/</code>, <code>/p/</code>, <code>/tv/</code> links).',
      'photo posts and carousels. a carousel opens a picker so you can take some slides or all of them. a link that ends in <code>?img_index=</code> and a number gets that one slide.',
      'stories and highlights, including the <code>/s/</code> links the share button makes. a highlight gives you its first 10 items.',
    ],
    how: 'gronka asks instagram the way a logged-out visitor would first. photo posts and stories need more than that, so gronka signs in to instagram itself and copies the file, kept for an hour.',
    faq: [
      [
        'can i save a whole carousel?',
        'yes. the picker shows every slide, and "all" saves them in one go.',
      ],
      shared.private,
      [
        'why did a story fail?',
        'stories vanish after 24 hours, so an old story link has nothing left to fetch.',
      ],
      shared.free,
    ],
  },
  {
    slug: 'x',
    name: 'x',
    title: 'x (twitter) video downloader: save videos and gifs',
    desc: 'save videos, gifs and images from x (twitter). works with x.com and twitter.com links. free, no ads, no account, no request logs.',
    lede: 'videos, gifs and images from x. twitter.com links work too.',
    placeholder: 'paste an x or twitter link',
    works: [
      'post links on <code>x.com</code> and <code>twitter.com</code>, plus embed mirrors like <code>fxtwitter.com</code> and <code>vxtwitter.com</code>.',
      'videos, gifs (x stores them as short videos) and images. a post with several goes to the picker.',
      'pick <strong>audio</strong> for the sound only.',
    ],
    how: "for a big video gronka often skips copying and hands you x's own video link. when it can't, it fetches the file itself and keeps the copy for an hour.",
    faq: [
      [
        'does twitter.com still work?',
        'yes. twitter.com and x.com links are the same thing to gronka.',
      ],
      [
        'why is my gif a video?',
        "x turns every gif into a short mp4. that's the file x has, so that's the file you get.",
      ],
      shared.private,
      shared.limits,
    ],
  },
  {
    slug: 'youtube',
    name: 'youtube',
    title: 'youtube downloader: videos, shorts and audio',
    desc: 'save a youtube video, a short, or just the audio as an mp3. trim to the part you want. free, no ads, no account, no request logs.',
    lede: 'videos, shorts and music links. take the whole thing, the audio, or a trimmed part.',
    placeholder: 'paste a youtube link',
    works: [
      'video, shorts, <code>youtu.be</code> and <code>music.youtube.com</code> links.',
      'pick <strong>audio</strong> for an mp3, or trim to keep only a part.',
      'a video over an hour is refused unless you trim it. files over 400 mb are refused too.',
    ],
    how: "youtube's file links only work for the address that asked for them, so gronka always fetches the video itself and hands you a copy that lasts an hour.",
    faq: [
      [
        'why is there a length limit?',
        'gronka fetches youtube files itself, so it keeps each one under 400 mb and an hour of video. trim a longer video and only that part is fetched.',
      ],
      ['can i get just the song?', 'yes. pick audio before you download and you get an mp3.'],
      shared.logs,
      shared.free,
    ],
  },
  {
    slug: 'reddit',
    name: 'reddit',
    title: 'reddit video downloader: videos, galleries, gifs',
    desc: 'save reddit videos with sound, whole galleries in order, and gifs from comments. paste the link, get the file. free, no ads.',
    lede: 'videos with their sound, galleries in order, and gifs from comments.',
    placeholder: 'paste a reddit link',
    works: [
      "post links, including the <code>/s/</code> links the share button makes. reddit's own video comes with its sound.",
      "galleries arrive in the post's order, in a picker, so you can take some or all. a gallery gives you its first 10 images.",
      "a link to one comment gets that comment's image or gif, not the whole thread.",
      'posts that only link somewhere else, like redgifs or imgur, are followed to the file.',
    ],
    how: 'gronka reads the post through reddit itself, keeping the post separate from its comments. images are fetched by gronka and kept for an hour.',
    faq: [
      [
        'why did it say the post is gone?',
        'the post was removed. gronka stops there instead of guessing.',
      ],
      [
        'do i get the comments too?',
        "no. a post link gets the post's own media. to get a comment's gif, link to that comment.",
      ],
      shared.private,
    ],
  },
  {
    slug: 'pinterest',
    name: 'pinterest',
    title: 'pinterest downloader: videos and full-size images',
    desc: 'save pinterest videos and full-size images. pin.it share links work. free, no ads, no account, no request logs.',
    lede: 'video pins and full-size images. pin.it links work.',
    placeholder: 'paste a pinterest link',
    works: [
      'pin links on <code>pinterest.com</code> and country sites like <code>pinterest.co.uk</code>, and <code>pin.it</code> share links.',
      'video pins as video, image pins at the original size.',
    ],
    how: 'gronka opens the pin page, reads the media address out of it, and fetches that file itself. the copy is kept for an hour.',
    faq: [
      ['do i get the small preview or the real image?', 'the original size pinterest stores.'],
      ['what if a pin has a video and an image?', 'you get the video.'],
      shared.free,
    ],
  },
  {
    slug: 'facebook',
    name: 'facebook',
    title: 'facebook video downloader',
    desc: 'save facebook videos. fb.watch links work. free, no ads, no account, no request logs.',
    lede: 'facebook videos. fb.watch links work too.',
    placeholder: 'paste a facebook link',
    works: [
      'video links on <code>facebook.com</code> and <code>fb.watch</code> short links.',
      'pick <strong>audio</strong> for the sound only, or trim a part out.',
    ],
    how: 'gronka asks for the video one way and, if that fails, tries a second way.',
    faq: [shared.private, shared.free, shared.limits],
  },
];

const HOME = {
  title: 'gronka: free video downloader, no ads, no account',
  desc: 'paste a link from tiktok, instagram, x, youtube, reddit and more, get the file. free, no ads, no account, no request logs.',
  faq: [
    shared.free,
    [
      'which sites work?',
      'tiktok, instagram, x, youtube, reddit, bluesky, pinterest, facebook, imgur, tumblr, twitch clips, soundcloud and more.',
    ],
    shared.logs,
    shared.limits,
  ],
};

const esc = text =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ld = data => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

function faqLd(faq) {
  return {
    '@type': 'FAQPage',
    mainEntity: faq.map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
}

const faqHtml = faq =>
  `<h2>questions</h2>\n${faq.map(([q, a]) => `<h3>${esc(q)}</h3>\n<p>${esc(a)}</p>`).join('\n')}`;

const sitesNav = current =>
  `<nav class="sites" aria-label="downloaders by site"><h2>by site</h2><ul>${PLATFORMS.map(p =>
    p.slug === current
      ? `<li><a href="/${p.slug}/" aria-current="page">${p.name}</a></li>`
      : `<li><a href="/${p.slug}/">${p.name}</a></li>`
  ).join('')}</ul></nav>`;

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

function withMore(html, more) {
  html = html.replace(/\s*<section class="more">[\s\S]*?<\/section>\s*(?=<footer)/, '\n\n    ');
  return html.replace(
    /(\s*)<footer class="foot">/,
    `$1<section class="more">\n${more}\n    </section>\n$1<footer class="foot">`
  );
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

let home = fs.readFileSync(new URL('index.html', ROOT), 'utf8');
home = withHead(home, {
  title: HOME.title,
  desc: HOME.desc,
  url: `${SITE}/`,
  jsonld: [app, faqLd(HOME.faq)],
});
home = withMore(home, `${sitesNav(null)}\n${faqHtml(HOME.faq)}`);
fs.writeFileSync(new URL('index.html', ROOT), home);

for (const p of PLATFORMS) {
  const url = `${SITE}/${p.slug}/`;
  let page = withHead(home, {
    title: `${p.title} | gronka`,
    desc: p.desc,
    url,
    jsonld: [
      { ...app, url },
      faqLd(p.faq),
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
    [/<h1>[\s\S]*?<\/h1>/, `<h1>${esc(p.name)} downloader.</h1>`],
    [/<p class="lede">[\s\S]*?<\/p>/, `<p class="lede">${esc(p.lede)}</p>`],
    [/placeholder="paste a link"/, `placeholder="${esc(p.placeholder)}"`],
  ];
  for (const [pattern, text] of swaps) {
    if (!pattern.test(page)) throw new Error(`template lost ${pattern}`);
    page = page.replace(pattern, text);
  }
  const more = [
    `<h2>what works</h2>\n<ul>${p.works.map(w => `<li>${w}</li>`).join('')}</ul>`,
    `<h2>how the file gets to you</h2>\n<p>${esc(p.how)} <a href="/privacy/">more on that</a>.</p>`,
    faqHtml(p.faq),
    sitesNav(p.slug),
    `<p><a href="/">every other site</a> works from the main page too.</p>`,
  ].join('\n');
  page = withMore(page, more);
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
console.log(`home + ${PLATFORMS.length} pages, sitemap ${urls.length} urls`);
