import json
import sys

from curl_cffi import CurlOpt, requests


def fetch_page(options):
    body = bytearray()

    def receive(chunk):
        if len(body) + len(chunk) > options['maxBytes']:
            raise ValueError('page exceeds the response size limit')
        body.extend(chunk)

    with requests.Session(
        trust_env=False,
        curl_options={CurlOpt.RESOLVE: [options['resolve']], CurlOpt.PROXY: ''},
    ) as session:
        response = session.get(
            options['url'],
            headers=options['headers'],
            impersonate='chrome',
            allow_redirects=False,
            timeout=options['timeoutMs'] / 1000,
            content_callback=receive,
        )
    return {
        'status': response.status_code,
        'headers': {'location': response.headers.get('location')},
        'data': body.decode('utf-8', errors='replace'),
    }


try:
    result = fetch_page(json.load(sys.stdin))
except Exception as error:
    result = {'error': str(error)[:1000], 'code': getattr(error, 'code', None)}
print(json.dumps(result))
