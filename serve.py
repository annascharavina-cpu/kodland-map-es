import os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 3459
import http.server, socketserver
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, f, *a): pass
with socketserver.TCPServer(('', port), H) as s:
    s.serve_forever()
