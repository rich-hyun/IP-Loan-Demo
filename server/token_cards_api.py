"""Public token artwork for already-public application metadata; no source PDFs or keys."""
import functools
import hashlib
import json
import os
import re
from threading import Lock

from flask import Response, jsonify, request
if __package__:
    from . import token_media
else:
    import token_media

_render_lock = Lock()


@functools.lru_cache(maxsize=32)
def render(public_json, debt):
    # Font/Pillow work is bounded and shared across simultaneous browser requests.
    return token_media.card(json.loads(public_json), debt)[0]


def register(native):
    def find(app_id):
        app = native.find_application(app_id)
        if not app or not app.get('appKey'):
            return None
        return app

    @native.app.route('/api/applications/<app_id>/token-cards/<kind>.png')
    def image(app_id, kind):
        app = find(app_id)
        if app is None or kind not in {'sbt', 'debt'}:
            return native.error_response('토큰 카드를 찾을 수 없습니다.', 404, 'token_card_not_found')
        # Explicit whitelist: never pass the full DB row to the public renderer.
        public = {key: app.get(key) for key in ('id', 'company', 'ceo', 'ipTitle')}
        try:
            with _render_lock:
                png = render(json.dumps(public, ensure_ascii=False, sort_keys=True), kind == 'debt')
        except token_media.TokenMediaError:
            return native.error_response('토큰 카드 글꼴 설정을 확인해 주세요.', 503, 'token_font_missing')
        response = Response(png, mimetype='image/png')
        response.set_etag(hashlib.sha256(png).hexdigest())
        response.headers['Cache-Control'] = 'private, max-age=300'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response.make_conditional(request)

    @native.app.route('/api/applications/<app_id>/tokens')
    def tokens(app_id):
        app = find(app_id)
        if app is None:
            return native.error_response('온체인 신청을 찾을 수 없습니다.', 404, 'token_card_not_found')
        try:
            cfg = native.chain.config()
            snapshot = native.chain.snapshot(app)
        except native.chain.ChainError as exc:
            return native.error_response(str(exc), 503, 'token_chain_unavailable')
        stage = snapshot['chainStatus']
        token_id = snapshot.get('sbtTokenId')
        origin = '/api/applications/' + app_id + '/token-cards/'
        common = {'chainId': app['chainId'], 'managerAddress': app['managerAddress'],
                  'tokenId': token_id, 'chainBlock': snapshot['chainBlock']}
        gateway = os.environ.get('IPLOAN_IPFS_GATEWAY', 'https://rwa-gw.mustree.kr/ipfs/').rstrip('/') + '/'
        def media(prefix):
            uri, image_uri = app.get(prefix+'MetadataUri'), app.get(prefix+'ImageUri')
            if not uri or not image_uri:
                return {}
            if not all(re.fullmatch(r'ipfs://[A-Za-z0-9]{10,128}', value) for value in (uri, image_uri)):
                return {}
            return {'metadataUri': uri, 'imageUri': image_uri, 'imageUrl': gateway+image_uri[7:], 'onChainMetadata': stage != 'None'}
        published = bool(app.get('sbtMetadataUri') and app.get('debtMetadataUri'))
        return jsonify({'applicationId': app_id, 'chainStatus': stage, 'artworkSource': 'ipfs' if published else 'application-preview',
                        'walletImageAvailable': published and stage != 'None', 'tokens': [
            {**common, 'kind': 'sbt', 'label': '평가보고서 열람 SBT', 'contractAddress': cfg['accessSBTAddress'],
             'state': 'issued' if stage == 'Evaluating' else 'pending' if stage == 'None' else 'burned',
             'owner': app['evaluatorWallet'] if stage == 'Evaluating' else None,
             'recipient': app['evaluatorWallet'], 'imagePath': origin + 'sbt.png', **media('sbt')},
            {**common, 'kind': 'debt', 'label': '대출채권 NFT', 'contractAddress': cfg['debtNFTAddress'],
             'state': 'issued' if stage in {'Approved', 'Repaid'} else 'pending',
             'owner': app.get('bankWallet') if stage in {'Approved', 'Repaid'} else None,
             'recipient': app.get('bankWallet'), 'imagePath': origin + 'debt.png', **media('debt')},
        ]})
