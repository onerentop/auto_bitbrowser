import http.server
import socketserver
import json
import os
import sys
import urllib.parse
import threading

# Add parent dir to path to import database
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(CURRENT_DIR)
if PARENT_DIR not in sys.path:
    sys.path.append(PARENT_DIR)

from services.database import DBManager

PORT = 8080
TEMPLATE_DIR = os.path.join(CURRENT_DIR, 'templates')
STATIC_DIR = os.path.join(CURRENT_DIR, 'static')

class AccountHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass # Silence logs to avoid creating noise in main GUI console

    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        path = parsed_path.path
        
        if path == '/':
            self.send_response(200)
            self.send_header('Content-type', 'text/html; charset=utf-8')
            self.end_headers()
            with open(os.path.join(TEMPLATE_DIR, 'index.html'), 'rb') as f:
                self.wfile.write(f.read())
            return
            
        if path.startswith('/static/'):
            rel_path = path[1:] # e.g. static/css/style.css
            full_path = os.path.join(CURRENT_DIR, rel_path)
            if os.path.exists(full_path):
                self.send_response(200)
                ext = os.path.splitext(full_path)[1]
                content_type = {
                    '.css': 'text/css',
                    '.js': 'application/javascript',
                    '.png': 'image/png'
                }.get(ext, 'text/plain')
                self.send_header('Content-type', content_type)
                self.end_headers()
                with open(full_path, 'rb') as f:
                    self.wfile.write(f.read())
            else:
                self.send_error(404)
            return

        if path == '/api/accounts':
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            accounts = DBManager.get_all_accounts()
            self.wfile.write(json.dumps(accounts, default=str).encode('utf-8'))
            return

        self.send_error(404)

    def do_POST(self):
        parsed_path = urllib.parse.urlparse(self.path)
        if parsed_path.path == '/api/export':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            params = json.loads(post_data.decode('utf-8'))
            
            target_emails = set(params.get('emails', []))
            fields = params.get('fields', ['email'])
            
            all_accs = DBManager.get_all_accounts()
            export_lines = []
            
            for acc in all_accs:
                if acc['email'] in target_emails:
                    parts = []
                    for f in fields:
                        val = acc.get(f) or ''
                        parts.append(str(val))
                    export_lines.append('----'.join(parts))
            
            output = '\n'.join(export_lines)
            
            self.send_response(200)
            self.send_header('Content-type', 'text/plain')
            self.send_header('Content-Disposition', 'attachment; filename="export.txt"')
            self.end_headers()
            self.wfile.write(output.encode('utf-8'))
            return
            
        self.send_error(404)

def run_server(port=8080):
    # Ensure dirs exist
    os.makedirs(TEMPLATE_DIR, exist_ok=True)
    os.makedirs(os.path.join(STATIC_DIR, 'css'), exist_ok=True)
    os.makedirs(os.path.join(STATIC_DIR, 'js'), exist_ok=True)
    
    DBManager.init_db()
    
    # Allow logic to rebind quickly
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(("", port), AccountHandler) as httpd:
            print(f"WEB ADMIN STARTED: http://localhost:{port}")
            httpd.serve_forever()
    except OSError as e:
        print(f"Web Admin Port {port} busy or error: {e}")

if __name__ == "__main__":
    run_server()
