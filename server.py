#!/usr/bin/env python3
import json
import os
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse
from cryptography.fernet import Fernet

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / 'frontend'
DATA_DIR = BASE_DIR / 'data'
DB_PATH = DATA_DIR / 'app.db'
TARGET_URL_DEFAULT = 'http://blackcat2.vankeservice.com/platSellerWeb/dist/dist-gray/index.html#/login'
DATA_DIR.mkdir(parents=True, exist_ok=True)


def now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'


def current_month() -> str:
    return datetime.utcnow().strftime('%Y-%m')


def ensure_key() -> bytes:
    key = os.environ.get('APP_FERNET_KEY')
    key_file = DATA_DIR / 'fernet.key'
    if key:
        return key.encode()
    if key_file.exists():
        return key_file.read_text().strip().encode()
    generated = Fernet.generate_key()
    key_file.write_text(generated.decode())
    return generated


FERNET = Fernet(ensure_key())


def encrypt_secret(value: str) -> str:
    return FERNET.encrypt(value.encode()).decode() if value else ''


def decrypt_secret(value: str) -> str:
    return FERNET.decrypt(value.encode()).decode() if value else ''


def connect_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = connect_db()
    cur = conn.cursor()
    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_name TEXT NOT NULL,
            login_name TEXT NOT NULL,
            password_encrypted TEXT NOT NULL,
            note TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'normal',
            month_quota INTEGER NOT NULL DEFAULT 30,
            used_coupon_count INTEGER NOT NULL DEFAULT 0,
            remain_coupon_count INTEGER NOT NULL DEFAULT 30,
            last_success_time TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pay_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            input_amount INTEGER NOT NULL,
            required_coupon_count INTEGER NOT NULL,
            split_round_count INTEGER NOT NULL,
            success_coupon_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            execution_mode TEXT NOT NULL DEFAULT 'mock',
            duplicate_warning INTEGER NOT NULL DEFAULT 0,
            error_message TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            finished_at TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS pay_task_rounds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pay_task_id INTEGER NOT NULL,
            round_no INTEGER NOT NULL,
            round_amount INTEGER NOT NULL,
            required_coupon_count INTEGER NOT NULL,
            success_coupon_count INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            error_message TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            finished_at TEXT DEFAULT '',
            FOREIGN KEY(pay_task_id) REFERENCES pay_tasks(id)
        );

        CREATE TABLE IF NOT EXISTS pay_task_details (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pay_task_id INTEGER NOT NULL,
            pay_task_round_id INTEGER NOT NULL,
            account_id INTEGER NOT NULL,
            used_coupon_count INTEGER NOT NULL,
            deduct_amount INTEGER NOT NULL,
            result TEXT NOT NULL,
            error_message TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            FOREIGN KEY(pay_task_id) REFERENCES pay_tasks(id),
            FOREIGN KEY(pay_task_round_id) REFERENCES pay_task_rounds(id),
            FOREIGN KEY(account_id) REFERENCES accounts(id)
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """
    )
    defaults = {
        'target_url': TARGET_URL_DEFAULT,
        'execution_mode': 'mock',
        'require_confirmation': 'true',
        'last_month_reset': current_month(),
    }
    for k, v in defaults.items():
        cur.execute('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)', (k, v))
    conn.commit()
    conn.close()


@dataclass
class PreviewPlan:
    amount: int
    required_coupon_count: int
    round_amounts: List[int]
    round_plans: List[Dict[str, Any]]
    account_summary: List[Dict[str, Any]]
    insufficient: bool
    total_remaining: int
    duplicate_warning: bool


class ExecutorAdapter:
    name = 'base'

    def execute_round(self, account: Dict[str, Any], amount: int, coupon_count: int, round_no: int, target_url: str) -> Dict[str, Any]:
        raise NotImplementedError


class MockExecutorAdapter(ExecutorAdapter):
    name = 'mock'

    def execute_round(self, account: Dict[str, Any], amount: int, coupon_count: int, round_no: int, target_url: str) -> Dict[str, Any]:
        return {
            'ok': True,
            'message': f'模拟执行成功：第{round_no}轮 {amount}元，账号 {account["owner_name"]} 使用 {coupon_count} 张。',
            'trace': {
                'executor': self.name,
                'target_url': target_url,
                'round_no': round_no,
            },
        }


class ApprovedIntegrationOnlyAdapter(ExecutorAdapter):
    name = 'approved_integration_only'

    def execute_round(self, account: Dict[str, Any], amount: int, coupon_count: int, round_no: int, target_url: str) -> Dict[str, Any]:
        return {
            'ok': False,
            'message': '当前未启用真实第三方执行器。请通过获得批准的官方接口或你自建的合规执行服务接入。',
            'trace': {'executor': self.name, 'target_url': target_url, 'round_no': round_no},
        }


class AppService:
    def __init__(self):
        self.adapters = {
            'mock': MockExecutorAdapter(),
            'approved_integration_only': ApprovedIntegrationOnlyAdapter(),
        }

    def get_setting(self, key: str) -> str:
        conn = connect_db()
        row = conn.execute('SELECT value FROM settings WHERE key = ?', (key,)).fetchone()
        conn.close()
        return row['value'] if row else ''

    def set_setting(self, key: str, value: str) -> None:
        conn = connect_db()
        conn.execute('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, value))
        conn.commit()
        conn.close()

    def get_config(self) -> Dict[str, Any]:
        return {
            'target_url': self.get_setting('target_url'),
            'execution_mode': self.get_setting('execution_mode'),
            'require_confirmation': self.get_setting('require_confirmation') == 'true',
        }

    def update_config(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        if 'target_url' in payload:
            self.set_setting('target_url', str(payload['target_url']).strip() or TARGET_URL_DEFAULT)
        if 'execution_mode' in payload:
            mode = str(payload['execution_mode']).strip()
            if mode not in self.adapters:
                raise ValueError('不支持的 execution_mode')
            self.set_setting('execution_mode', mode)
        if 'require_confirmation' in payload:
            self.set_setting('require_confirmation', 'true' if bool(payload['require_confirmation']) else 'false')
        self.audit('update_config', payload)
        return self.get_config()

    def audit(self, action: str, payload: Dict[str, Any]) -> None:
        conn = connect_db()
        conn.execute(
            'INSERT INTO audit_logs(action, payload_json, created_at) VALUES(?, ?, ?)',
            (action, json.dumps(payload, ensure_ascii=False), now_iso()),
        )
        conn.commit()
        conn.close()

    def month_reset_if_needed(self) -> None:
        last_reset = self.get_setting('last_month_reset')
        month = current_month()
        if last_reset == month:
            return
        conn = connect_db()
        conn.execute(
            'UPDATE accounts SET used_coupon_count = 0, remain_coupon_count = month_quota, updated_at = ?',
            (now_iso(),),
        )
        conn.commit()
        conn.close()
        self.set_setting('last_month_reset', month)
        self.audit('month_reset', {'month': month})

    def list_accounts(self) -> List[Dict[str, Any]]:
        self.month_reset_if_needed()
        conn = connect_db()
        rows = conn.execute('SELECT * FROM accounts ORDER BY status = "normal" DESC, remain_coupon_count DESC, id ASC').fetchall()
        conn.close()
        result = []
        for row in rows:
            item = dict(row)
            item['password'] = decrypt_secret(item.pop('password_encrypted')) if item.get('password_encrypted') else ''
            result.append(item)
        return result

    def create_account(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        owner_name = str(payload.get('owner_name', '')).strip()
        login_name = str(payload.get('login_name', '')).strip()
        password = str(payload.get('password', '')).strip()
        note = str(payload.get('note', '')).strip()
        if not owner_name or not login_name:
            raise ValueError('owner_name 和 login_name 必填')
        month_quota = int(payload.get('month_quota') or 30)
        remain = int(payload.get('remain_coupon_count') or month_quota)
        status = str(payload.get('status') or 'normal')
        if status not in ('normal', 'abnormal', 'disabled'):
            status = 'normal'
        now = now_iso()
        conn = connect_db()
        cur = conn.cursor()
        cur.execute(
            '''INSERT INTO accounts(owner_name, login_name, password_encrypted, note, status, month_quota, used_coupon_count, remain_coupon_count, last_success_time, created_at, updated_at)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (owner_name, login_name, encrypt_secret(password), note, status, month_quota, max(month_quota - remain, 0), remain, '', now, now),
        )
        account_id = cur.lastrowid
        conn.commit()
        conn.close()
        self.audit('create_account', {'account_id': account_id, 'owner_name': owner_name})
        return self.get_account(account_id)

    def get_account(self, account_id: int) -> Dict[str, Any]:
        conn = connect_db()
        row = conn.execute('SELECT * FROM accounts WHERE id = ?', (account_id,)).fetchone()
        conn.close()
        if not row:
            raise KeyError('账号不存在')
        item = dict(row)
        item['password'] = decrypt_secret(item.pop('password_encrypted')) if item.get('password_encrypted') else ''
        return item

    def update_account(self, account_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
        account = self.get_account(account_id)
        owner_name = str(payload.get('owner_name', account['owner_name'])).strip()
        login_name = str(payload.get('login_name', account['login_name'])).strip()
        password = str(payload.get('password', account['password'])).strip()
        note = str(payload.get('note', account.get('note', ''))).strip()
        status = str(payload.get('status', account['status'])).strip()
        month_quota = int(payload.get('month_quota', account['month_quota']))
        remain = int(payload.get('remain_coupon_count', account['remain_coupon_count']))
        used = max(month_quota - remain, 0)
        conn = connect_db()
        conn.execute(
            '''UPDATE accounts SET owner_name=?, login_name=?, password_encrypted=?, note=?, status=?, month_quota=?, used_coupon_count=?, remain_coupon_count=?, updated_at=? WHERE id=?''',
            (owner_name, login_name, encrypt_secret(password), note, status, month_quota, used, remain, now_iso(), account_id),
        )
        conn.commit()
        conn.close()
        self.audit('update_account', {'account_id': account_id})
        return self.get_account(account_id)

    def delete_account(self, account_id: int) -> None:
        conn = connect_db()
        conn.execute('DELETE FROM accounts WHERE id = ?', (account_id,))
        conn.commit()
        conn.close()
        self.audit('delete_account', {'account_id': account_id})

    def calc_round_amounts(self, amount: int) -> List[int]:
        rounds = []
        remaining = amount
        while remaining > 25:
            rounds.append(25)
            remaining -= 25
        if remaining > 0:
            rounds.append(remaining)
        return rounds

    def get_normal_accounts(self) -> List[Dict[str, Any]]:
        return [a for a in self.list_accounts() if a['status'] == 'normal' and a['remain_coupon_count'] > 0]

    def recent_duplicate_warning(self, amount: int) -> bool:
        conn = connect_db()
        threshold = (datetime.utcnow() - timedelta(minutes=2)).replace(microsecond=0).isoformat() + 'Z'
        row = conn.execute(
            '''SELECT id FROM pay_tasks WHERE input_amount = ? AND status IN ('success', 'partial_success') AND created_at >= ? ORDER BY id DESC LIMIT 1''',
            (amount, threshold),
        ).fetchone()
        conn.close()
        return row is not None

    def build_preview(self, amount: int) -> PreviewPlan:
        if amount <= 0 or amount % 5 != 0:
            raise ValueError('金额必须是大于0的5元整数倍')
        accounts = self.get_normal_accounts()
        total_remaining = sum(a['remain_coupon_count'] for a in accounts)
        required = amount // 5
        rounds = self.calc_round_amounts(amount)
        insufficient = total_remaining < required
        # Greedy: sort by remaining desc then id, consume minimal number of accounts.
        working = [{**a} for a in accounts]
        working.sort(key=lambda x: (-x['remain_coupon_count'], x['id']))
        round_plans = []
        account_summary_map: Dict[int, Dict[str, Any]] = {}
        for idx, round_amount in enumerate(rounds, start=1):
            need = round_amount // 5
            allocations = []
            for acc in working:
                if need <= 0:
                    break
                if acc['remain_coupon_count'] <= 0:
                    continue
                use = min(acc['remain_coupon_count'], need)
                if use <= 0:
                    continue
                acc['remain_coupon_count'] -= use
                need -= use
                allocations.append({
                    'account_id': acc['id'],
                    'owner_name': acc['owner_name'],
                    'login_name': acc['login_name'],
                    'coupon_count': use,
                    'deduct_amount': use * 5,
                })
                summary = account_summary_map.setdefault(acc['id'], {
                    'account_id': acc['id'],
                    'owner_name': acc['owner_name'],
                    'login_name': acc['login_name'],
                    'coupon_count': 0,
                    'deduct_amount': 0,
                })
                summary['coupon_count'] += use
                summary['deduct_amount'] += use * 5
            round_plans.append({
                'round_no': idx,
                'round_amount': round_amount,
                'required_coupon_count': round_amount // 5,
                'allocations': allocations,
                'satisfied': need == 0,
            })
        return PreviewPlan(
            amount=amount,
            required_coupon_count=required,
            round_amounts=rounds,
            round_plans=round_plans,
            account_summary=list(sorted(account_summary_map.values(), key=lambda x: (-x['coupon_count'], x['account_id']))),
            insufficient=insufficient,
            total_remaining=total_remaining,
            duplicate_warning=self.recent_duplicate_warning(amount),
        )

    def list_tasks(self) -> List[Dict[str, Any]]:
        conn = connect_db()
        rows = conn.execute('SELECT * FROM pay_tasks ORDER BY id DESC LIMIT 100').fetchall()
        tasks = [dict(r) for r in rows]
        for task in tasks:
            rounds = conn.execute('SELECT * FROM pay_task_rounds WHERE pay_task_id = ? ORDER BY round_no ASC', (task['id'],)).fetchall()
            task['rounds'] = []
            for rr in rounds:
                r = dict(rr)
                details = conn.execute('SELECT d.*, a.owner_name, a.login_name FROM pay_task_details d JOIN accounts a ON a.id = d.account_id WHERE d.pay_task_round_id = ? ORDER BY d.id ASC', (r['id'],)).fetchall()
                r['details'] = [dict(x) for x in details]
                task['rounds'].append(r)
        conn.close()
        return tasks

    def execute_task(self, amount: int, confirmed: bool) -> Dict[str, Any]:
        config = self.get_config()
        if config['require_confirmation'] and not confirmed:
            raise ValueError('需要确认后才能执行')
        preview = self.build_preview(amount)
        if preview.insufficient:
            raise ValueError(f'当前总剩余券不足，还差 {preview.required_coupon_count - preview.total_remaining} 张')
        execution_mode = config['execution_mode']
        adapter = self.adapters[execution_mode]
        conn = connect_db()
        cur = conn.cursor()
        created = now_iso()
        cur.execute(
            '''INSERT INTO pay_tasks(input_amount, required_coupon_count, split_round_count, status, execution_mode, duplicate_warning, created_at)
               VALUES(?, ?, ?, ?, ?, ?, ?)''',
            (amount, preview.required_coupon_count, len(preview.round_amounts), 'running', execution_mode, 1 if preview.duplicate_warning else 0, created),
        )
        task_id = cur.lastrowid
        success_total = 0
        task_status = 'success'
        task_error = ''
        try:
            for round_plan in preview.round_plans:
                round_created = now_iso()
                cur.execute(
                    '''INSERT INTO pay_task_rounds(pay_task_id, round_no, round_amount, required_coupon_count, status, created_at)
                       VALUES(?, ?, ?, ?, ?, ?)''',
                    (task_id, round_plan['round_no'], round_plan['round_amount'], round_plan['required_coupon_count'], 'running', round_created),
                )
                round_id = cur.lastrowid
                round_success = 0
                round_status = 'success'
                round_error = ''
                for alloc in round_plan['allocations']:
                    account_row = conn.execute('SELECT * FROM accounts WHERE id = ?', (alloc['account_id'],)).fetchone()
                    account = dict(account_row)
                    result = adapter.execute_round(account, alloc['deduct_amount'], alloc['coupon_count'], round_plan['round_no'], config['target_url'])
                    detail_status = 'success' if result['ok'] else 'failed'
                    cur.execute(
                        '''INSERT INTO pay_task_details(pay_task_id, pay_task_round_id, account_id, used_coupon_count, deduct_amount, result, error_message, created_at)
                           VALUES(?, ?, ?, ?, ?, ?, ?, ?)''',
                        (task_id, round_id, alloc['account_id'], alloc['coupon_count'], alloc['deduct_amount'], detail_status, '' if result['ok'] else result['message'], now_iso()),
                    )
                    if result['ok']:
                        round_success += alloc['coupon_count']
                        success_total += alloc['coupon_count']
                        new_remain = max(account['remain_coupon_count'] - alloc['coupon_count'], 0)
                        new_used = account['used_coupon_count'] + alloc['coupon_count']
                        cur.execute(
                            'UPDATE accounts SET remain_coupon_count = ?, used_coupon_count = ?, last_success_time = ?, updated_at = ? WHERE id = ?',
                            (new_remain, new_used, now_iso(), now_iso(), alloc['account_id']),
                        )
                    else:
                        round_status = 'failed' if round_success == 0 else 'partial_success'
                        round_error = result['message']
                        break
                if round_success < round_plan['required_coupon_count'] and round_status == 'success':
                    round_status = 'failed'
                    round_error = '轮次扣费未完全满足'
                cur.execute(
                    'UPDATE pay_task_rounds SET success_coupon_count = ?, status = ?, error_message = ?, finished_at = ? WHERE id = ?',
                    (round_success, round_status, round_error, now_iso(), round_id),
                )
                if round_status != 'success':
                    task_status = 'partial_success' if success_total > 0 else 'failed'
                    task_error = round_error
                    break
            cur.execute(
                'UPDATE pay_tasks SET success_coupon_count = ?, status = ?, error_message = ?, finished_at = ? WHERE id = ?',
                (success_total, task_status, task_error, now_iso(), task_id),
            )
            conn.commit()
        except Exception as e:
            conn.rollback()
            raise
        finally:
            conn.close()
        self.audit('execute_task', {'task_id': task_id, 'amount': amount, 'status': task_status})
        return next(t for t in self.list_tasks() if t['id'] == task_id)

    def monthly_summary(self) -> Dict[str, Any]:
        accounts = self.list_accounts()
        tasks = self.list_tasks()
        month = current_month()
        return {
            'month': month,
            'active_account_count': len([a for a in accounts if a['status'] == 'normal']),
            'total_coupon_count': sum(a['month_quota'] for a in accounts if a['status'] == 'normal'),
            'used_coupon_count': sum(a['used_coupon_count'] for a in accounts),
            'remain_coupon_count': sum(a['remain_coupon_count'] for a in accounts),
            'total_deduct_amount': sum(t['success_coupon_count'] for t in tasks) * 5,
            'failed_task_count': len([t for t in tasks if t['status'] == 'failed']),
            'partial_task_count': len([t for t in tasks if t['status'] == 'partial_success']),
        }


APP = AppService()


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FRONTEND_DIR), **kwargs)

    def _json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> Dict[str, Any]:
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length).decode('utf-8') if length else '{}'
        return json.loads(raw or '{}')

    def log_message(self, fmt: str, *args) -> None:
        sys.stdout.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
        self.end_headers()

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == '/api/config':
            return self._json(200, {'ok': True, 'data': APP.get_config()})
        if path == '/api/accounts':
            return self._json(200, {'ok': True, 'data': APP.list_accounts()})
        if path == '/api/stats' or path == '/api/monthly-summary':
            return self._json(200, {'ok': True, 'data': APP.monthly_summary()})
        if path == '/api/tasks':
            return self._json(200, {'ok': True, 'data': APP.list_tasks()})
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            payload = self._read_json()
            if path == '/api/config':
                return self._json(200, {'ok': True, 'data': APP.update_config(payload)})
            if path == '/api/accounts':
                return self._json(201, {'ok': True, 'data': APP.create_account(payload)})
            if path == '/api/tasks/preview':
                amount = int(payload.get('amount') or 0)
                preview = APP.build_preview(amount)
                return self._json(200, {'ok': True, 'data': preview.__dict__})
            if path == '/api/tasks':
                amount = int(payload.get('amount') or 0)
                confirmed = bool(payload.get('confirmed'))
                task = APP.execute_task(amount, confirmed)
                return self._json(201, {'ok': True, 'data': task})
            if path == '/api/admin/reset-month':
                APP.set_setting('last_month_reset', '')
                APP.month_reset_if_needed()
                return self._json(200, {'ok': True, 'data': APP.monthly_summary()})
            return self._json(404, {'ok': False, 'error': 'Not found'})
        except ValueError as e:
            return self._json(400, {'ok': False, 'error': str(e)})
        except KeyError as e:
            return self._json(404, {'ok': False, 'error': str(e)})
        except Exception as e:
            return self._json(500, {'ok': False, 'error': f'服务错误: {e}'})

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith('/api/accounts/'):
                account_id = int(path.rsplit('/', 1)[-1])
                payload = self._read_json()
                return self._json(200, {'ok': True, 'data': APP.update_account(account_id, payload)})
            return self._json(404, {'ok': False, 'error': 'Not found'})
        except ValueError as e:
            return self._json(400, {'ok': False, 'error': str(e)})
        except KeyError as e:
            return self._json(404, {'ok': False, 'error': str(e)})
        except Exception as e:
            return self._json(500, {'ok': False, 'error': f'服务错误: {e}'})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith('/api/accounts/'):
                account_id = int(path.rsplit('/', 1)[-1])
                APP.delete_account(account_id)
                return self._json(200, {'ok': True})
            return self._json(404, {'ok': False, 'error': 'Not found'})
        except Exception as e:
            return self._json(500, {'ok': False, 'error': f'服务错误: {e}'})


def run(host: str = '0.0.0.0', port: int = 8000):
    init_db()
    APP.month_reset_if_needed()
    server = ThreadingHTTPServer((host, port), AppHandler)
    print(f'Server running at http://{host}:{port}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopping server...')
    finally:
        server.server_close()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8000'))
    host = os.environ.get('HOST', '0.0.0.0')
    run(host, port)
