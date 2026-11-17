"""SIR BOT AI per-user MT5 bridge. Safe default: DRY RUN; no orders are sent."""
import os, time, json, sqlite3, logging
from pathlib import Path
import requests
import MetaTrader5 as mt5

API_BASE = os.getenv('SIRBOT_API_BASE', 'https://sir-bot-ai-backend.rolix717.workers.dev').rstrip('/')
BRIDGE_TOKEN = os.getenv('SIRBOT_BRIDGE_TOKEN', '').strip()
POLL_SECONDS = int(os.getenv('SIRBOT_POLL_SECONDS', '3'))
LOCAL_EXECUTION_ENABLED = os.getenv('SIRBOT_EXECUTION_ENABLED', 'false').lower() == 'true'
# Keep false until demo execution has been separately validated and approved.
DEMO_ONLY = True
DB_PATH = Path(__file__).with_name('sirbot_execution_ledger.sqlite3')
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

if not BRIDGE_TOKEN:
    raise SystemExit('Missing SIRBOT_BRIDGE_TOKEN. Set it locally; never share it.')

http = requests.Session()
http.headers.update({'Authorization': f'Bearer {BRIDGE_TOKEN}', 'Content-Type': 'application/json'})

def ledger():
    db = sqlite3.connect(DB_PATH)
    db.execute('CREATE TABLE IF NOT EXISTS handled(signal_id TEXT PRIMARY KEY, result TEXT NOT NULL, handled_at TEXT DEFAULT CURRENT_TIMESTAMP)')
    db.commit(); return db

def ack(signal_id, result):
    try:
        r = http.post(API_BASE + '/mt5/ack-signal', json={'signalId': signal_id, 'result': result}, timeout=15)
        r.raise_for_status()
    except Exception as exc:
        logging.error('Acknowledgement failed for %s: %s', signal_id, exc)

def connect_mt5():
    if not mt5.initialize():
        raise RuntimeError(f'MT5 initialize failed: {mt5.last_error()}')
    account = mt5.account_info()
    if account is None:
        raise RuntimeError('MT5 account info unavailable. Log in to your terminal first.')
    logging.info('Connected to MT5 login ending %s; server=%s; balance=%.2f; currency=%s', str(account.login)[-4:], account.server, account.balance, account.currency)
    return account

def validate_signal(signal):
    if signal.get('decision') not in ('BUY', 'SELL'): return False, 'Invalid direction'
    if not signal.get('symbol') or not signal.get('stopLoss'): return False, 'Missing symbol or stop loss'
    if float(signal['entry']) <= 0 or float(signal['stopLoss']) <= 0: return False, 'Invalid price levels'
    if signal['decision'] == 'BUY' and float(signal['stopLoss']) >= float(signal['entry']): return False, 'BUY stop loss must be below entry'
    if signal['decision'] == 'SELL' and float(signal['stopLoss']) <= float(signal['entry']): return False, 'SELL stop loss must be above entry'
    return True, 'Validated'

def handle(signal, execution):
    sid = signal['signalId']; db = ledger()
    if db.execute('SELECT 1 FROM handled WHERE signal_id=?', (sid,)).fetchone():
        ack(sid, 'DUPLICATE'); logging.info('Duplicate signal skipped: %s', sid); db.close(); return
    ok, reason = validate_signal(signal)
    if not ok:
        logging.warning('Rejected %s: %s', sid, reason); db.execute('INSERT OR IGNORE INTO handled(signal_id,result) VALUES(?,?)',(sid,'REJECTED')); db.commit(); db.close(); ack(sid,'REJECTED'); return
    symbol = execution.get('symbol') or signal.get('symbol')
    if not mt5.symbol_select(symbol, True):
        logging.warning('Symbol %s unavailable in this MT5 account.', symbol)
        db.close(); ack(sid,'REJECTED'); return
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        logging.warning('No live tick for %s', symbol); db.close(); ack(sid,'REJECTED'); return
    logging.info('SIGNAL %s %s | %s | entry %.3f | SL %.3f | TP1 %.3f | confidence %s%%', sid[:12], signal['decision'], symbol, float(signal['entry']), float(signal['stopLoss']), float(signal.get('tp1') or 0), signal.get('confidence'))
    # Intentionally do not submit orders. Server and local execution gates are both off.
    if not (LOCAL_EXECUTION_ENABLED and execution.get('enabled') and not execution.get('demoOnly', True) and not DEMO_ONLY):
        db.execute('INSERT OR IGNORE INTO handled(signal_id,result) VALUES(?,?)',(sid,'DRY_RUN')); db.commit(); db.close(); ack(sid,'DRY_RUN'); return
    # Live order placement is deliberately not implemented/enabled in this release.
    # This prevents an unverified strategy or incorrect broker symbol from placing trades.
    db.close(); ack(sid,'REJECTED')

def main():
    connect_mt5(); logging.info('SIR BOT AI bridge running. EXECUTION DISABLED; monitoring per-user queue.')
    while True:
        try:
            r = http.get(API_BASE + '/mt5/next-signal', timeout=20); r.raise_for_status(); data = r.json()
            signal = data.get('signal')
            if signal: handle(signal, data.get('execution') or {})
            else: time.sleep(POLL_SECONDS)
        except KeyboardInterrupt: break
        except Exception as exc: logging.exception('Bridge loop error: %s', exc); time.sleep(5)
    mt5.shutdown()

if __name__ == '__main__': main()
