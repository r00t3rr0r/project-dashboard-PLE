import contextlib
import io
import json
import os
import stat
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import storage_server as storage


class SetupTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        patcher = mock.patch.multiple(
            storage,
            DB_PATH=os.path.join(self.directory.name, 'test.sqlite'),
            SETUP_CODE=None,
            SETUP_ATTEMPTS={},
            AUTH_ATTEMPTS={},
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        backup = mock.patch.object(storage, 'ensure_daily_backup')
        backup.start()
        self.addCleanup(backup.stop)
        schedule = mock.patch.object(storage, 'schedule_full_backup')
        schedule.start()
        self.addCleanup(schedule.stop)
        with contextlib.closing(storage.open_db_connection()) as connection:
            connection.execute('CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt TEXT NOT NULL)')
            connection.execute('INSERT INTO kv_store VALUES (?, ?, ?)', ('pd_projects', '[{"id":"existing"}]', storage.utc_now_iso_z()))
            connection.execute('INSERT INTO kv_store VALUES (?, ?, ?)', ('pd_employees', json.dumps([{
                'id': 'existing', 'name': 'Existing', 'auth': {'login': {'enabled': False, 'username': 'existing'}}
            }]), storage.utc_now_iso_z()))
            connection.commit()
        with contextlib.redirect_stdout(io.StringIO()):
            storage.initialize_setup()
        self.code = storage.SETUP_CODE
        self.server = storage.DashboardHTTPServer(('127.0.0.1', 0), storage.StorageHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.url = 'http://127.0.0.1:' + str(self.server.server_address[1])

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, payload=None, headers=None):
        body = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(self.url + path, data=body, headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.load(response), response.headers
        except urllib.error.HTTPError as error:
            return error.code, json.load(error), error.headers

    def payload(self, **overrides):
        result = {'code': self.code, 'name': 'Admin', 'username': 'Admin.User', 'password': 'long-password-123'}
        result.update(overrides)
        return result

    def test_setup_preserves_data_allows_login_and_cannot_repeat(self):
        code_path = os.path.join(self.directory.name, '.setup-code')
        self.assertEqual(self.code, '1337')
        with open(code_path, encoding='utf-8') as code_file:
            self.assertEqual(code_file.read().strip(), '1337')
        with contextlib.redirect_stdout(io.StringIO()):
            storage.initialize_setup()
        self.assertEqual(storage.SETUP_CODE, '1337')
        self.assertEqual(stat.S_IMODE(os.stat(code_path).st_mode), 0o600)
        self.assertEqual(self.request('/api/setup/status')[1], {'available': True})
        self.assertEqual(self.request('/api/setup/admin', self.payload(code='wrong'))[0], 403)
        self.assertEqual(self.request('/api/setup/admin', self.payload(password='short'))[0], 400)
        self.assertEqual(self.request('/api/setup/admin', self.payload(username='existing'))[0], 400)
        status, result, _ = self.request('/api/setup/admin', self.payload())
        self.assertEqual((status, result['username']), (200, 'admin.user'))
        self.assertFalse(os.path.exists(code_path))
        self.assertEqual(self.request('/api/setup/status')[1], {'available': False})
        self.assertEqual(self.request('/api/setup/admin', self.payload())[0], 409)
        with contextlib.closing(storage.open_db_connection()) as connection:
            rows = dict(connection.execute('SELECT key, value FROM kv_store').fetchall())
        self.assertEqual(json.loads(rows['pd_projects']), [{'id': 'existing'}])
        employees = json.loads(rows['pd_employees'])
        self.assertEqual(employees[0]['id'], 'existing')
        self.assertEqual(employees[1]['auth']['accessLevel'], 'admin')
        self.assertTrue(employees[1]['auth']['login']['passwordHash'].startswith('pbkdf2$180000$'))
        self.assertNotIn('long-password-123', rows['pd_employees'])
        self.assertEqual(rows['pd_setup_guide'], 'team')
        status, login, headers = self.request('/api/auth/login', {'username': 'admin.user', 'password': 'long-password-123'})
        self.assertEqual(status, 200)
        self.assertEqual(login['employeeId'], employees[1]['id'])
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        with contextlib.redirect_stdout(io.StringIO()):
            storage.initialize_setup()
        self.assertIsNone(storage.SETUP_CODE)

    def test_two_simultaneous_setup_requests_create_only_one_admin(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda name: self.request('/api/setup/admin', self.payload(username=name))[0], ['first', 'second']))
        self.assertEqual(sorted(results), [200, 409])
        with contextlib.closing(storage.open_db_connection()) as connection:
            employees = json.loads(connection.execute('SELECT value FROM kv_store WHERE key = ?', ('pd_employees',)).fetchone()[0])
        self.assertEqual(len(employees), 2)

    def test_origin_and_attempt_limit(self):
        self.assertEqual(self.request('/api/setup/admin', self.payload(), {'Origin': 'https://untrusted.example'})[0], 403)
        for _ in range(10):
            self.assertEqual(self.request('/api/setup/admin', self.payload(code='wrong'))[0], 403)
        self.assertEqual(self.request('/api/setup/admin', self.payload())[0], 429)


if __name__ == '__main__':
    unittest.main()
