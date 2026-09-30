"""Browser mutations, credentialed CORS and share-token response boundaries."""
from unittest.mock import patch

from fastapi import FastAPI, Response
from fastapi.testclient import TestClient
from starlette.middleware.cors import CORSMiddleware

from app.config import settings
from app.core.origins import allowed_api_origins
from app.middleware.http import BrowserOriginMiddleware, ResponseCacheMiddleware, SecurityHeadersMiddleware, _redact_sensitive_path


def client():
    app = FastAPI()
    @app.post('/api/change')
    def change():
        return {'ok': True}
    @app.get('/api/private')
    def private():
        return {'name': 'private'}
    @app.get('/api/show-shares/secret')
    def share(response: Response):
        response.headers['Referrer-Policy'] = 'no-referrer'
        return {'ok': True}
    @app.get('/share/shows/secret')
    def share_page():
        return Response('<html>share</html>', media_type='text/html')
    app.add_middleware(CORSMiddleware, allow_origins=allowed_api_origins(), allow_credentials=True, allow_methods=['GET', 'POST'])
    app.add_middleware(BrowserOriginMiddleware)
    app.add_middleware(ResponseCacheMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    return TestClient(app)


def test_untrusted_origins_cannot_mutate_even_with_cookies():
    with patch.object(settings, 'allowed_host', '*'), client() as browser:
        browser.cookies.set('slideflow_session', 'cookie')
        for headers in [{'Origin': 'https://evil.example'}, {'Origin': 'null'}, {'Sec-Fetch-Site': 'cross-site'}]:
            response = browser.post('/api/change', headers=headers)
            assert response.status_code == 403
            assert 'no-store' in response.headers['cache-control']
        assert browser.post('/api/change', headers={'Origin': 'http://testserver'}).status_code == 200
        assert browser.post('/api/change').status_code == 200  # non-browser clients


def test_explicit_origin_and_same_origin_proxy_metadata_are_supported():
    with patch.object(settings, 'allowed_host', 'https://ui.example,localhost,*,https://bad.example/path'), client() as browser:
        assert allowed_api_origins() == ['https://ui.example']
        response = browser.post('/api/change', headers={'Origin': 'https://ui.example', 'Sec-Fetch-Site': 'cross-site'})
        assert response.status_code == 200
        assert response.headers['access-control-allow-origin'] == 'https://ui.example'
        assert response.headers['access-control-allow-credentials'] == 'true'
        assert browser.post('/api/change', headers={'Origin': 'http://localhost:5173', 'Sec-Fetch-Site': 'same-origin'}).status_code == 200
        assert browser.post('/api/change', headers={'Origin': 'https://ui.example.evil'}).status_code == 403


def test_wildcard_configuration_does_not_enable_credentialed_cors():
    with patch.object(settings, 'allowed_host', '*'), client() as browser:
        response = browser.options('/api/change', headers={'Origin': 'https://evil.example', 'Access-Control-Request-Method': 'POST'})
        assert response.status_code == 400
        assert 'access-control-allow-origin' not in response.headers


def test_private_api_and_share_pages_are_not_cached_and_share_referrer_is_not_overridden():
    with client() as browser:
        for path in ['/api/private', '/api/show-shares/secret', '/share/shows/secret', '/api/show-shares/missing']:
            response = browser.get(path)
            assert 'no-store' in response.headers['cache-control']
            if 'share' in path:
                assert response.headers.get_list('referrer-policy') == ['no-referrer']
        for path in ['/api/resource-shares/token/preview', '/api/show-shares/token/preview/1', '/share/resources/token', '/share/shows/token']:
            assert 'token' not in _redact_sensitive_path(path)
