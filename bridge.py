"""SIR BOT AI MT5 live execution bridge.

Places orders on verified DEMO or REAL MT5 accounts. The active account mode is
detected from the connected terminal; contest accounts are rejected. Risk and
position caps are enforced locally even if a server response is misconfigured.
"""
import os, time, json, sqlite3, logging
from pathlib import Path
from datetime import datetime, time as dt_time
import requests
import MetaTrader5 as mt5

API_BASE = os.getenv('SIRBOT_API_BASE', 'https://sir-bot-ai-backend.rolix717.workers.dev').rstrip('/')
BRIDGE_TOKEN = os.getenv('SIRBOT_BRIDGE_TOKEN', '').strip()
POLL_SECONDS = max(2, int(os.getenv('SIRBOT_POLL_SECONDS', '3')))
LOCAL_MAX_POSITIONS = min(5, max(1, int(os.getenv('SIRBOT_MAX_POSITIONS', '5'))))
LOCAL_RISK_PERCENT = min(0.25, max(0.05, float(os.getenv('SIRBOT_RISK_PERCENT', '0.25'))))
LOCAL_DAILY_LOSS_LIMIT = min(1.0, max(0.25, float(os.getenv('SIRBOT_DAILY_LOSS_LIMIT', '1.0'))))
MAGIC = 26111801
DEVIATION = 30
DB_PATH = Path(__file__).with_name('sirbot_execution_ledger.sqlite3')
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
if not BRIDGE_TOKEN:
    raise SystemExit('Missing SIRBOT_BRIDGE_TOKEN. Set it locally; never share it.')
http = requests.Session()
http.headers.update({'Authorization': f'Bearer {BRIDGE_TOKEN}', 'Content-Type': 'application/json'})


def ledger():
    db = sqlite3.connect(DB_PATH)
    db.execute('CREATE TABLE IF NOT EXISTS handled(signal_id TEXT PRIMARY KEY, result TEXT NOT NULL, handled_at TEXT DEFAULT CURRENT_TIMESTAMP)')
    db.commit()
    return db


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
    logging.info('MT5 connected: login ending %s; server=%s; account mode=%s; balance=%.2f %s',
                 str(account.login)[-4:], account.server, account.trade_mode, account.balance, account.currency)
    mode = account_mode_name(account.trade_mode)
    if mode == 'UNSUPPORTED':
        logging.error('Execution locked: MT5 contest or unknown account mode is not supported.')
    else:
        logging.info('Execution mode available: %s account.', mode)
    return account


def account_mode_name(trade_mode):
    if trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO:
        return 'DEMO'
    if trade_mode == mt5.ACCOUNT_TRADE_MODE_REAL:
        return 'REAL'
    return 'UNSUPPORTED'


def resolve_gold_symbol(preferred=None):
    candidates=[]
    for name in [preferred, 'XAUUSD', 'XAUUSDm', 'XAUUSD.', 'GOLD', 'GOLDm']:
        if name and name not in candidates: candidates.append(name)
    for name in candidates:
        info=mt5.symbol_info(name)
        if info is not None and mt5.symbol_select(name, True): return name
    try:
        for item in (mt5.symbols_get() or []):
            compact=item.name.upper().replace('.','').replace('_','').replace('-','')
            if compact.endswith('XAUUSD') or compact.startswith('XAUUSD') or compact in ('GOLD','GOLDM'):
                if mt5.symbol_select(item.name, True): return item.name
    except Exception as exc: logging.warning('Symbol catalogue lookup failed: %s', exc)
    return None


def validate_signal(s):
    try:
        if s.get('decision') not in ('BUY','SELL'): return False,'Invalid direction'
        if not s.get('signalId') or not s.get('stopLoss'): return False,'Missing signal ID or stop loss'
        if float(s['entry']) <= 0 or float(s['stopLoss']) <= 0: return False,'Invalid prices'
        if s['decision']=='BUY' and float(s['stopLoss']) >= float(s['entry']): return False,'BUY stop loss must be below entry'
        if s['decision']=='SELL' and float(s['stopLoss']) <= float(s['entry']): return False,'SELL stop loss must be above entry'
        return True,'Validated'
    except (TypeError,ValueError): return False,'Malformed signal prices'


def today_realized_pnl():
    now=datetime.now()
    start=datetime.combine(now.date(),dt_time.min)
    deals=mt5.history_deals_get(start,now) or []
    return sum(float(d.profit)+float(d.commission)+float(d.swap) for d in deals)


def open_positions_count():
    return len(mt5.positions_get() or [])


def volume_for_risk(symbol, order_type, price, sl, balance, risk_pct):
    risk_cash=balance*risk_pct/100.0
    loss=mt5.order_calc_profit(order_type,symbol,1.0,price,sl)
    if loss is None or abs(float(loss)) <= 0:
        raise RuntimeError(f'Cannot calculate contract risk for {symbol}: {mt5.last_error()}')
    info=mt5.symbol_info(symbol)
    if info is None: raise RuntimeError('Symbol metadata unavailable')
    raw=risk_cash/abs(float(loss))
    step=float(info.volume_step or 0.01)
    vol=min(float(info.volume_max), raw)
    vol=(vol//step)*step
    vol=round(vol,8)
    if vol < float(info.volume_min):
        raise RuntimeError(f'Calculated volume {vol} is below broker minimum {info.volume_min}; trade skipped to avoid exceeding risk cap.')
    return vol


def execute_live(signal, settings):
    if not settings.get('enabled'):
        raise RuntimeError('MT5 execution is disabled for this bridge connection.')
    account=mt5.account_info()
    if account is None: raise RuntimeError('MT5 account disconnected')
    account_mode = account_mode_name(account.trade_mode)
    if account_mode == 'UNSUPPORTED':
        raise RuntimeError('Account mode not supported. Use an MT5 DEMO or REAL account; contest accounts are rejected.')
    if not account.trade_allowed or not account.trade_expert:
        raise RuntimeError('MT5 account or Expert Advisor trading permission is disabled.')
    max_positions=min(LOCAL_MAX_POSITIONS,int(settings.get('maxPositions') or 5),5)
    if open_positions_count() >= max_positions:
        raise RuntimeError(f'Maximum simultaneous positions reached ({max_positions}).')
    daily_limit=min(LOCAL_DAILY_LOSS_LIMIT,float(settings.get('dailyLossLimit') or 1.0))
    pnl=today_realized_pnl()
    if pnl <= -(float(account.balance)*daily_limit/100.0):
        raise RuntimeError(f'Daily loss limit reached ({daily_limit:.2f}%); trading locked until next broker day.')
    risk_pct=min(LOCAL_RISK_PERCENT,float(settings.get('riskPercent') or LOCAL_RISK_PERCENT))
    symbol=resolve_gold_symbol(settings.get('symbol') or signal.get('symbol'))
    if not symbol: raise RuntimeError('Gold symbol not found in this broker terminal.')
    info=mt5.symbol_info(symbol); tick=mt5.symbol_info_tick(symbol)
    if info is None or tick is None: raise RuntimeError('Live symbol price unavailable.')
    if info.trade_mode == mt5.SYMBOL_TRADE_MODE_DISABLED: raise RuntimeError('Broker has disabled trading for this symbol.')
    buy=signal['decision']=='BUY'
    order_type=mt5.ORDER_TYPE_BUY if buy else mt5.ORDER_TYPE_SELL
    price=float(tick.ask if buy else tick.bid)
    sl=float(signal['stopLoss'])
    tp=float(signal.get('tp1') or 0)
    if (buy and sl>=price) or ((not buy) and sl<=price): raise RuntimeError('Signal stop loss is now on the wrong side of the live market price; trade skipped.')
    if tp and ((buy and tp<=price) or ((not buy) and tp>=price)): raise RuntimeError('Take profit is now on the wrong side of the live market price; trade skipped.')
    stops_level=float(info.trade_stops_level or 0)*float(info.point)
    if abs(price-sl)<stops_level or (tp and abs(tp-price)<stops_level): raise RuntimeError('SL/TP is inside broker minimum stop distance.')
    digits=int(info.digits)
    price=round(price,digits); sl=round(sl,digits); tp=round(tp,digits) if tp else 0.0
    volume=volume_for_risk(symbol,order_type,price,sl,float(account.balance),risk_pct)
    margin=mt5.order_calc_margin(order_type,symbol,volume,price)
    if margin is None or float(margin) > float(account.margin_free):
        raise RuntimeError('Insufficient free margin for calculated position size.')
    filling = mt5.ORDER_FILLING_IOC if (int(info.filling_mode) & 2) else mt5.ORDER_FILLING_FOK
    request={
        'action':mt5.TRADE_ACTION_DEAL,'symbol':symbol,'volume':volume,'type':order_type,
        'price':price,'sl':sl,'tp':tp,'deviation':DEVIATION,'magic':MAGIC,
        'comment':f'SIRBOT-{str(signal.get("strategy") or "NORMAL")[:5]} {str(signal.get("signalId"))[:8]}',
        'type_time':mt5.ORDER_TIME_GTC,'type_filling':filling
    }
    result=mt5.order_send(request)
    if result is None: raise RuntimeError(f'MT5 order_send returned no result: {mt5.last_error()}')
    if result.retcode not in (mt5.TRADE_RETCODE_DONE,mt5.TRADE_RETCODE_PLACED,mt5.TRADE_RETCODE_DONE_PARTIAL):
        raise RuntimeError(f'Broker rejected order: retcode={result.retcode}, comment={result.comment}')
    return {'symbol':symbol,'volume':volume,'price':price,'sl':sl,'tp':tp,'ticket':result.order,'deal':result.deal,'retcode':result.retcode}


def handle(signal, settings):
    sid=signal.get('signalId','')
    if not sid: logging.warning('Signal without ID skipped'); return
    db=ledger()
    if db.execute('SELECT 1 FROM handled WHERE signal_id=?',(sid,)).fetchone():
        ack(sid,'DUPLICATE'); logging.info('Duplicate signal skipped: %s',sid); db.close(); return
    ok,reason=validate_signal(signal)
    if not ok:
        db.execute('INSERT OR IGNORE INTO handled(signal_id,result) VALUES(?,?)',(sid,'REJECTED')); db.commit(); db.close(); ack(sid,'REJECTED'); logging.warning(reason); return
    try:
        result=execute_live(signal,settings)
        detail=json.dumps(result)
        db.execute('INSERT OR IGNORE INTO handled(signal_id,result) VALUES(?,?)',(sid,'EXECUTED '+detail)); db.commit()
        logging.info('LIVE ORDER EXECUTED [%s]: %s %s %.2f lots, ticket=%s',signal.get('strategy','NORMAL'),signal['decision'],result['symbol'],result['volume'],result['ticket'])
        ack(sid,'EXECUTED')
    except Exception as exc:
        logging.error('Order not placed for %s: %s',sid,exc)
        db.execute('INSERT OR IGNORE INTO handled(signal_id,result) VALUES(?,?)',(sid,'REJECTED '+str(exc))); db.commit(); ack(sid,'REJECTED')
    finally: db.close()


def main():
    connect_mt5()
    logging.info('SIR BOT AI bridge started (DEMO + REAL accounts supported). Hard limit: %s simultaneous positions; risk <= %.2f%% per trade; daily loss cap <= %.2f%%.',LOCAL_MAX_POSITIONS,LOCAL_RISK_PERCENT,LOCAL_DAILY_LOSS_LIMIT)
    while True:
        try:
            r=http.get(API_BASE+'/mt5/next-signal',timeout=20); r.raise_for_status(); data=r.json()
            signal=data.get('signal')
            if signal: handle(signal,data.get('execution') or {})
            else: time.sleep(POLL_SECONDS)
        except KeyboardInterrupt: break
        except Exception as exc: logging.exception('Bridge loop error: %s',exc); time.sleep(5)
    mt5.shutdown()

if __name__=='__main__': main()
