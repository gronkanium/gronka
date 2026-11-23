from yt_dlp.extractor.common import InfoExtractor
from yt_dlp.utils import int_or_none, traverse_obj, url_or_none


class XHamsterShortsIE(InfoExtractor):
    IE_NAME = 'xhamster:shorts'
    _VALID_URL = r'https?://(?:[^/?#]+\.)?xhamster\.com/shorts/(?:[^/?#]+-)?(?P<id>xh\w+)'

    def _real_extract(self, url):
        video_id = self._match_id(url)
        webpage = self._download_webpage(url, video_id)
        initials = self._search_json(r'window\.initials\s*=', webpage, 'initials', video_id)
        # US visitors get an age-gated page with no momentProps; the geo proxy gets the real one.
        moment = traverse_obj(initials, ('layoutPage', 'momentProps', {dict}))
        if not moment:
            self.raise_geo_restricted('this short is age-gated where the request came from')
        formats = []
        for source in traverse_obj(moment, ('sources', 'standard', 'h264', lambda _, v: url_or_none(v['url']))):
            if source['url'].endswith('.m3u8'):
                formats.extend(self._extract_m3u8_formats(
                    source['url'], video_id, 'mp4', m3u8_id='hls', fatal=False))
            else:
                formats.append({
                    'url': source['url'],
                    'format_id': source.get('quality'),
                    'height': int_or_none(str(source.get('quality')).rstrip('p')),
                    'ext': 'mp4',
                })
        return {
            'id': video_id,
            'title': moment.get('title'),
            'duration': int_or_none(moment.get('duration')),
            'thumbnail': url_or_none(moment.get('posterUrl')),
            'age_limit': 18,
            'formats': formats,
        }
