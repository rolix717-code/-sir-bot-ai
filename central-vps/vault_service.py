"""SIR BOT AI central VPS credential-vault starter.
Credentials are encrypted at rest with AES-256-GCM. No admin password-reveal route.
This service is a scaffold: connect it to authenticated customer sessions before use.
"""
import os, base64, sqlite3, uuid, logging
from datetime import datetime, timezone
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

DB_PATH = os.getenv('SIRBOT_VAULT_DB', 'sirbot_vault.sqlite3')
KEY_B64 = os.getenv('SIRBOT_VAULT_KEY', '')
WORKER_TOKEN = os.getenv('SIRBOT_WORKER_TOKEN', '')
logging.basicConfig(level=logging.INFO)
log = logging.getLogger('sirbot-vault')
app = FastAPI(title='SIR BOT AI Central VPS Vault', version='0.1.0')

class AccountIn(BaseModel):
    owner_id: str = Field(min_length=1, max_length=128)
    broker: str = Field(min_length=2, max_length=80)
    login: str = Field(min_length=1, max_length=80)
    server: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=1, max_length=256)
    consent_live_trading: bool = False


def key():
    try: raw = base64.b64decode(KEY_B64, validate=True)
    except Exception: raw = b''
    if len(raw) != 32:
        raise RuntimeError('SIRBOT_VAULT_KEY must be a base64-encoded 32-byte key.')
    return raw

def db():
    con = sqlite3.connect(DB_PATH)
    con.execute('''CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, broker TEXT NOT NULL,
      login TEXT NOT NULL, server TEXT NOT NULL, nonce BLOB NOT NULL,
      ciphertext BLOB NOT NULL, consent_live INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING', created_at TEXT NOT NULL)''')
    con.commit(); return con

def worker_auth(auth):
    if not WORKER_TOKEN or auth != f'Bearer {WORKER_TOKEN}':
        raise HTTPException(401, 'Worker authentication failed')

@app.get('/health')
def health(): return {'ok': True, 'service': 'sirbot-central-vps-vault', 'execution': 'DISABLED'}

@app.post('/accounts')
def create_account(item: AccountIn):
    # IMPORTANT: reverse-proxy this route behind the website's verified customer session.
    # Never expose it publicly without authentication, ownership checks and rate limiting.
    ident = str(uuid.uuid4()); nonce = os.urandom(12)
    aad = f'{ident}:{item.owner_id}:{item.login}:{item.server}'.encode()
    encrypted = AESGCM(key()).encrypt(nonce, item.password.encode(), aad)
    con = db()
    con.execute('INSERT INTO accounts VALUES (?,?,?,?,?,?,?,?,?,?)',
      (ident,item.owner_id,item.broker,item.login,item.server,nonce,encrypted,
       int(item.consent_live_trading),'PENDING',datetime.now(timezone.utc).isoformat()))
    con.commit(); con.close()
    log.info('Credential stored for account_id=%s owner_id=%s; password omitted', ident, item.owner_id)
    return {'ok':True,'account_id':ident,'status':'PENDING','execution_enabled':False,
            'message':'Credentials encrypted. MT5 connection still requires worker provisioning.'}

@app.get('/worker/accounts/{account_id}')
def worker_get_account(account_id: str, authorization: str = Header(default='')):
    worker_auth(authorization)
    con=db(); row=con.execute('SELECT owner_id,broker,login,server,nonce,ciphertext FROM accounts WHERE id=?',(account_id,)).fetchone(); con.close()
    if not row: raise HTTPException(404,'Account not found')
    owner,broker,login,server,nonce,ciphertext=row
    aad=f'{account_id}:{owner}:{login}:{server}'.encode()
    try: password=AESGCM(key()).decrypt(nonce,ciphertext,aad).decode()
    except Exception: raise HTTPException(500,'Credential decryption failed')
    log.info('Worker retrieved credential for account_id=%s; secret omitted',account_id)
    return {'account_id':account_id,'owner_id':owner,'broker':broker,'login':login,'server':server,'password':password}

@app.delete('/accounts/{account_id}')
def delete_account(account_id: str, authorization: str = Header(default='')):
    # Worker-token protection here is temporary; production deletion must use customer ownership auth.
    worker_auth(authorization)
    con=db(); cur=con.execute('DELETE FROM accounts WHERE id=?',(account_id,)); con.commit(); con.close()
    return {'ok':True,'deleted':cur.rowcount==1}
