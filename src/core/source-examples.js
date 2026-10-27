// Public posts the nightly source check downloads; `site` is the Sources page id, `expect` what a
// working extractor returns. Pick posts from accounts that do not delete things.
export const SOURCE_EXAMPLES = [
  {
    site: 'youtube',
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    expect: { type: 'video' },
  },
  {
    site: 'youtube',
    url: 'https://www.youtube.com/shorts/0uWzj4AiiZ8',
    expect: { type: 'video' },
  },
  {
    site: 'youtube',
    url: 'https://youtu.be/dQw4w9WgXcQ',
    expect: { type: 'video' },
  },
  {
    site: 'youtube',
    url: 'https://www.youtube.com/post/UgkxINZg-LGTx0m4AWchhyV7Ulhmc4S1X59s',
    expect: { type: 'gif' },
  },
  {
    site: 'imgur',
    url: 'https://imgur.com/gallery/ctQTDDt',
    expect: { type: 'image' },
  },
  {
    site: 'imgur',
    url: 'https://imgur.com/gallery/gY8fr3n',
    expect: { type: 'video' },
  },
  {
    site: 'imgur',
    url: 'https://imgur.com/gallery/RUyywE4',
    expect: { type: 'image', count: 3 },
  },
  {
    site: 'kick',
    url: 'https://kick.com/kick/clips/clip_01JVZ8W7B060CSRDVMM7WHZM5H',
    expect: { type: 'video' },
  },
  {
    site: 'coub',
    url: 'https://coub.com/view/1trhlvc',
    expect: { type: 'video' },
  },
  {
    site: 'rumble',
    url: 'https://rumble.com/vkq5dw-friendly-humpback-whale-gives-woman-an-unforgettable-experience.html',
    expect: { type: 'video' },
  },
  {
    site: 'niconico',
    url: 'https://www.nicovideo.jp/watch/sm9',
    expect: { type: 'video' },
  },
  {
    site: 'bilibili',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    expect: { type: 'video' },
  },
  {
    site: 'bandcamp',
    url: 'https://youtube-dl.bandcamp.com/track/youtube-dl-test-song',
    expect: { type: 'audio' },
  },
  {
    site: 'medal',
    url: 'https://medal.tv/games/clippords-clips/clips/1aOnX9X39EbuhM',
    expect: { type: 'video' },
  },
  {
    site: 'gallery-dl-deviantart',
    url: 'https://www.deviantart.com/team/art/Celebrating-100M-Deviants-1158706745',
    expect: { type: 'image' },
  },
  {
    site: 'gallery-dl-artstation',
    url: 'https://www.artstation.com/artwork/xYQrQ4',
    expect: { type: 'image', count: 2 },
  },
  {
    site: 'gallery-dl-flickr',
    url: 'https://www.flickr.com/photos/library_of_congress/4483935673/',
    expect: { type: 'image' },
  },
  {
    site: 'gallery-dl-wallhaven',
    url: 'https://wallhaven.cc/w/0qo2r4',
    expect: { type: 'image' },
  },
  {
    site: 'gallery-dl-mangadex',
    url: 'https://mangadex.org/chapter/aaa8687d-7b4d-40de-9772-cd2cc9fedacd',
    expect: { type: 'image', count: 11 },
  },
  {
    site: 'klipy',
    url: 'https://klipy.com/gifs/cats-kittens-106',
    expect: { type: 'gif' },
  },
  {
    site: 'tenor',
    url: 'https://tenor.com/view/banana-cat-gif-2736737110227615394',
    expect: { type: 'gif' },
  },
  {
    site: 'giphy',
    url: 'https://giphy.com/gifs/cat-lol-vFKqnCdLPNOKc',
    expect: { type: 'gif' },
  },
  {
    site: 'redgifs',
    url: 'https://www.redgifs.com/watch/peacefulrapidbrownbear',
    expect: { type: 'video' },
  },
  {
    site: 'xvideos',
    url: 'https://www.xvideos.com/video.hcdbfbfd8dd/brazzers_-_brazzers_exxtra_-_extra_amenities_scene_starring_lela_star_and_sean_lawless',
    expect: { type: 'video' },
  },
  {
    site: 'pornhub',
    url: 'https://www.pornhub.com/view_video.php?viewkey=ph584b3f77e4a16',
    expect: { type: 'video' },
  },
  {
    site: 'redtube',
    url: 'https://www.redtube.com/800741',
    expect: { type: 'video' },
  },
  {
    site: 'gallery-dl-nhentai',
    url: 'https://nhentai.net/g/103795/',
    expect: { type: 'archive' },
  },
  {
    site: 'hentaigifz',
    url: 'https://hentaigifz.com/tifa-lockhart-fabulous-boobs-moves/',
    expect: { type: 'gif' },
  },
  {
    site: 'danbooru',
    url: 'https://danbooru.donmai.us/posts/209392',
    expect: { type: 'image' },
  },
  {
    site: 'danbooru',
    url: 'https://danbooru.donmai.us/posts/6702154',
    expect: { type: 'video' },
  },
  {
    site: 'danbooru',
    url: 'https://danbooru.donmai.us/posts/3593542',
    expect: { type: 'gif' },
  },
  {
    site: 'e621',
    url: 'https://e926.net/posts/3744825',
    expect: { type: 'image' },
  },
  {
    site: 'e621',
    url: 'https://e621.net/posts/2855855',
    expect: { type: 'image' },
  },
  {
    site: 'yandere',
    url: 'https://yande.re/post/show/317740',
    expect: { type: 'image' },
  },
  {
    site: 'konachan',
    url: 'https://konachan.net/post/show/143486',
    expect: { type: 'image' },
  },
  {
    site: 'twitter',
    url: 'https://x.com/NASA/status/2112560723603632217',
    expect: { type: 'video' },
  },
  {
    site: 'twitter',
    url: 'https://x.com/NASA/status/2113655288687431819',
    expect: { type: 'image' },
  },
  {
    site: 'twitter',
    url: 'https://x.com/NASAWebb/status/2104950232530235654',
    expect: { type: 'image', count: 2 },
  },
  {
    site: 'twitter',
    url: 'https://x.com/NASAPersevere/status/1933295434015125694',
    expect: { type: 'gif' },
  },
  {
    site: 'bluesky',
    url: 'https://bsky.app/profile/esa.int/post/3mxytuoddfs2n',
    expect: { type: 'video' },
  },
  {
    site: 'bluesky',
    url: 'https://bsky.app/profile/esa.int/post/3mxvov77eus2p',
    expect: { type: 'image' },
  },
  {
    site: 'bluesky',
    url: 'https://bsky.app/profile/esa.int/post/3mvnh7whm3c2z',
    expect: { type: 'image', count: 2 },
  },
  {
    site: 'tiktok',
    url: 'https://www.tiktok.com/@natgeo/video/7055758356752977199',
    expect: { type: 'video' },
  },
  {
    site: 'tiktok',
    url: 'https://www.tiktok.com/@nasa/video/7679483952507276558',
    expect: { type: 'video' },
  },
  {
    site: 'tiktok',
    url: 'https://www.tiktok.com/@jcrew/photo/7351137284793650462',
    expect: { type: 'image', count: 7 },
  },
  {
    site: 'instagram',
    url: 'https://www.instagram.com/reel/Dbn-XJhk0_-/',
    expect: { type: 'video' },
  },
  {
    site: 'instagram',
    url: 'https://www.instagram.com/p/CPWZcYLplvu/',
    expect: { type: 'image' },
  },
  {
    site: 'instagram',
    url: 'https://www.instagram.com/p/CmUv48DLvxd/',
    expect: { type: 'image', count: 10 },
  },
  {
    site: 'reddit',
    url: 'https://www.reddit.com/r/u_nasa/comments/1jqpl8q/nasa_unveils_the_official_artemis_ii_mission_patch/',
    expect: { type: 'video' },
  },
  {
    site: 'reddit',
    url: 'https://www.reddit.com/r/u_nasa/comments/1ipfhdw/voyager_1s_pale_blue_dot_taken_35_years_ago_today/',
    expect: { type: 'image' },
  },
  {
    site: 'facebook',
    url: 'https://www.facebook.com/natgeo/videos/10153707971233951/',
    expect: { type: 'video' },
  },
  {
    site: 'facebook',
    url: 'https://www.facebook.com/natgeo/videos/10154879586498951/',
    expect: { type: 'video' },
  },
  {
    site: 'twitch',
    url: 'https://www.twitch.tv/nasa/clip/FitSnappyCaribouPhilosoraptor-F7IcTqcQWY2V9SrX',
    expect: { type: 'video' },
  },
  {
    site: 'twitch',
    url: 'https://www.twitch.tv/nasa/clip/ColdbloodedManlyPicklesHeyGuys-GQHPw9w7lt3PJQkX',
    expect: { type: 'video' },
  },
  {
    site: 'soundcloud',
    url: 'https://soundcloud.com/nasa/golden-record-english-greeting',
    expect: { type: 'audio' },
  },
  {
    site: 'soundcloud',
    url: 'https://soundcloud.com/nasa/sun-sonification',
    expect: { type: 'audio' },
  },
  {
    site: 'tumblr',
    url: 'https://nasa.tumblr.com/post/826039965713612800',
    expect: { type: 'video' },
  },
  {
    site: 'tumblr',
    url: 'https://nasa.tumblr.com/post/828471464226406400',
    expect: { type: 'image' },
  },
  {
    site: 'tumblr',
    url: 'https://nasa.tumblr.com/post/820337874767675392',
    expect: { type: 'image', count: 8 },
  },
  {
    site: 'streamable',
    url: 'https://streamable.com/4th3l',
    expect: { type: 'video' },
  },
  {
    site: 'streamable',
    url: 'https://streamable.com/njyj8',
    expect: { type: 'video' },
  },
  {
    site: 'dailymotion',
    url: 'https://www.dailymotion.com/video/x8da13x',
    expect: { type: 'video' },
  },
  {
    site: 'snapchat',
    url: 'https://www.snapchat.com/@nasa/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYb3pqZHN1Ymh6AZxxsFmSAZxxr_5ZAAAAAQ',
    expect: { type: 'video' },
  },
  {
    site: 'threads',
    url: 'https://www.threads.com/@nasa/post/Dd9aFLHgnnj',
    expect: { type: 'video' },
  },
  {
    site: 'threads',
    url: 'https://www.threads.com/@nasa/post/DduTJJdkvgg',
    expect: { type: 'image' },
  },
  {
    site: 'threads',
    url: 'https://www.threads.com/@nasa/post/Decc755lYhC',
    expect: { type: 'image', count: 4 },
  },
  {
    site: 'pinterest',
    url: 'https://www.pinterest.com/pin/142567144448879406/',
    expect: { type: 'video' },
  },
  {
    site: 'pinterest',
    url: 'https://www.pinterest.com/pin/142567144449027286/',
    expect: { type: 'image' },
  },
];
