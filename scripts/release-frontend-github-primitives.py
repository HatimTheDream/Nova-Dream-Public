"""Bounded GitHub API transport used by the configured release producers.

Credential acquisition belongs to release-delivery-ci.py, which verifies the
configured tool identities. This module contains no ambient tool defaults or
standalone account/backup operations.
"""
import json
import urllib.error
import urllib.request

class NoApiRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Generic urllib redirects can preserve Authorization across hosts.
        # API endpoints are exact; any redirect needs separate inspection.
        raise RuntimeError("GitHub API redirect rejected")

def api(path, token, method="GET", data=None):
    if not path.startswith("/"):
        raise ValueError("absolute GitHub API path required")
    headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Nova-Reviewed-Release"}
    encoded = None if data is None else json.dumps(data).encode()
    if encoded is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request("https://api.github.com" + path, data=encoded, headers=headers, method=method)
    try:
        with urllib.request.build_opener(NoApiRedirect()).open(request, timeout=45) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, {"error": "GitHub API rejected request"}

