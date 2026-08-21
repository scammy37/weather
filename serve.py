"""Local static server for the dashboard.

    python serve.py            # http://localhost:8080
    PORT=3000 python serve.py

Browsers block fetch() from file:// URLs, so the page needs to be served over
http even though it has no backend of its own.
"""
import os
import http.server
import functools

port = int(os.environ.get("PORT", 8080))
root = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # No caching in local dev, so an edit is visible on reload.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


handler = functools.partial(Handler, directory=root)
with http.server.ThreadingHTTPServer(("", port), handler) as httpd:
    print(f"Serving {root} on http://localhost:{port}", flush=True)
    httpd.serve_forever()
