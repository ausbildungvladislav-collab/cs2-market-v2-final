import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import cors from 'cors';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHANNEL_ID = process.env.CHANNEL_ID || '';
const telegramLoadedUsers=new Set();
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL || '';
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';
const ADMIN_IDS = new Set((process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
const DB_FILE = process.env.DATABASE_FILE || path.join(__dirname, 'data', 'cs2-market.sqlite');
const GITHUB_REPO = process.env.GITHUB_BACKUP_REPO || '';
const GITHUB_TOKEN = process.env.GITHUB_BACKUP_TOKEN || '';
const GITHUB_BRANCH = process.env.GITHUB_BACKUP_BRANCH || 'main';
const GITHUB_REPO_PARTS = GITHUB_REPO.split('/');
const GITHUB_CONFIGURED = Boolean(GITHUB_REPO || GITHUB_TOKEN);
if (GITHUB_CONFIGURED && (!GITHUB_REPO || !GITHUB_TOKEN || GITHUB_REPO_PARTS.length !== 2 || GITHUB_REPO_PARTS.some(x => !x))) throw new Error('Укажи GITHUB_BACKUP_REPO=owner/repo и GITHUB_BACKUP_TOKEN в Render.');
const GITHUB_ROOT = GITHUB_REPO ? `https://api.github.com/repos/${GITHUB_REPO_PARTS[0]}/${GITHUB_REPO_PARTS[1]}` : '';
const GITHUB_DB_PATH = 'backups/cs2-market.sqlite.gz';
const GITHUB_LOG_PATH = 'backups/log.txt';
const GITHUB_STATS_PATH = 'backups/stats.json';
let lastBackupHash = null;
let lastLogHash = null;
let lastStatsHash = null;
let backupInProgress = false;

async function githubApi(method, route, body) {
  const response = await fetch(GITHUB_ROOT + route, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + GITHUB_TOKEN,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cs2-market-backup',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${data.message || response.statusText}`);
  return data;
}
async function githubHead() {
  const ref = await githubApi('GET', `/git/ref/heads/${encodeURIComponent(GITHUB_BRANCH)}`);
  const commit = await githubApi('GET', `/git/commits/${ref.object.sha}`);
  return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
}
async function restoreDatabaseBackup() {
  if (!GITHUB_CONFIGURED) return false;
  const head = await githubHead();
  const tree = await githubApi('GET', `/git/trees/${head.treeSha}?recursive=1`);
  const entries = new Map((tree.tree || []).filter(item => item.type === 'blob').map(item => [item.path, item.sha]));
  const dbSha = entries.get(GITHUB_DB_PATH);
  if (!dbSha) {
    console.log('No GitHub database snapshot exists yet; a new database will be created.');
    return false;
  }
  const blob = await githubApi('GET', `/git/blobs/${dbSha}`);
  if (blob.encoding !== 'base64' || !blob.content) throw new Error('GitHub did not return the database snapshot as base64.');
  const databaseBytes = gunzipSync(Buffer.from(blob.content, 'base64'));
  const restorePath = DB_FILE + '.restore';
  fs.writeFileSync(restorePath, databaseBytes);
  fs.rmSync(DB_FILE, { force: true });
  fs.rmSync(DB_FILE + '-wal', { force: true });
  fs.rmSync(DB_FILE + '-shm', { force: true });
  fs.renameSync(restorePath, DB_FILE);
  lastBackupHash = crypto.createHash('sha256').update(databaseBytes).digest('hex');
  const logSha = entries.get(GITHUB_LOG_PATH);
  if (logSha) {
    const logBlob = await githubApi('GET', `/git/blobs/${logSha}`);
    if (logBlob.encoding === 'base64' && logBlob.content) lastLogHash = crypto.createHash('sha256').update(Buffer.from(logBlob.content, 'base64')).digest('hex');
  }
  console.log('Restored SQLite database from the private GitHub backup repository.');
  return true;
}
async function startServer() {
  fs.mkdirSync(path.dirname(path.resolve(DB_FILE)), { recursive: true });
  if(GITHUB_CONFIGURED)try{await restoreDatabaseBackup()}catch(error){console.error('GitHub database restore failed; Telegram channel restore can still recover player profiles:',error.message)}
  const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (telegram_id TEXT PRIMARY KEY, username TEXT NOT NULL, balance REAL NOT NULL DEFAULT 100, last_bonus TEXT, premium_until INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_active TEXT, account_status TEXT NOT NULL DEFAULT 'active', warning_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS inventory (telegram_id TEXT NOT NULL, skin_id TEXT NOT NULL, PRIMARY KEY(telegram_id, skin_id));
CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT NOT NULL, label TEXT NOT NULL, amount REAL NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, admin_id TEXT, reason TEXT);
`);
function safeLogValue(value) { return String(value ?? '').replace(/[\t\r\n|]/g, ' ').trim(); }
function createReadableLog() {
  const players = db.prepare(`SELECT u.telegram_id,u.username,u.balance,u.account_status,u.created_at,u.last_active,COALESCE((SELECT group_concat(i.skin_id, ', ') FROM inventory i WHERE i.telegram_id=u.telegram_id),'—') AS inventory FROM users u ORDER BY u.created_at,u.telegram_id`).all();
  const transactions = db.prepare('SELECT id,telegram_id,label,amount,admin_id,reason,created_at FROM transactions ORDER BY id DESC LIMIT 100').all();
  const games = db.prepare('SELECT event_id,telegram_id,game,outcome,wager,payout,created_at,updated_at FROM game_events ORDER BY id DESC LIMIT 100').all();
  const actions = db.prepare('SELECT admin_id,target_id,action,old_value,new_value,reason,created_at FROM admin_logs ORDER BY id DESC LIMIT 100').all();
  const lines = ['CS2 MARKET DATA SNAPSHOT', '', '[PLAYERS]', 'telegram_id\tusername\tbalance\tstatus\tregistered_at\tlast_active\tinventory'];
  for (const p of players) lines.push([p.telegram_id,p.username,Number(p.balance).toFixed(2),p.account_status,p.created_at,p.last_active||'—',p.inventory].map(safeLogValue).join('\t'));
  lines.push('', '[LAST 100 TRANSACTIONS]', 'id\ttelegram_id\tamount\tlabel\tadmin_id\treason\tcreated_at');
  for (const t of transactions) lines.push([t.id,t.telegram_id,Number(t.amount).toFixed(2),t.label,t.admin_id||'—',t.reason||'—',t.created_at].map(safeLogValue).join('\t'));
  lines.push('', '[LAST 100 GAMES]', 'event_id\ttelegram_id\tgame\toutcome\twager\tpayout\tcreated_at');
  for (const g of games) lines.push([g.event_id,g.telegram_id,g.game,g.outcome,Number(g.wager).toFixed(2),Number(g.payout).toFixed(2),g.created_at].map(safeLogValue).join('\t'));
  lines.push('', '[LAST 100 ADMIN ACTIONS]', 'admin_id\ttarget_id\taction\told_value\tnew_value\treason\tcreated_at');
  for (const a of actions) lines.push([a.admin_id,a.target_id||'—',a.action,a.old_value||'—',a.new_value||'—',a.reason,a.created_at].map(safeLogValue).join('\t'));
  return lines.join('\n') + '\n';
}
function createStatsSnapshot() {
  const scalar = sql => Number(db.prepare(sql).get().n || 0);
  const paidDonations = db.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(stars),0) AS stars FROM donations WHERE status='paid'").get();
  const integrity = db.prepare('PRAGMA quick_check').get()?.quick_check || 'unknown';
  return {
    generatedAt: new Date().toISOString(),
    backend: { status: 'online', uptimeSeconds: Math.round(process.uptime()), database: integrity },
    players: {
      total: scalar('SELECT COUNT(*) AS n FROM users'),
      onlineNow: connectedUsers.size,
      activeLast24h: scalar("SELECT COUNT(*) AS n FROM users WHERE last_active>=datetime('now','-24 hours')"),
      newLast24h: scalar("SELECT COUNT(*) AS n FROM users WHERE created_at>=datetime('now','-24 hours')"),
      blocked: scalar("SELECT COUNT(*) AS n FROM users WHERE account_status='blocked'")
    },
    economy: {
      virtualCoinsTotal: scalar('SELECT COALESCE(SUM(balance),0) AS n FROM users'),
      inventoryItems: scalar('SELECT COUNT(*) AS n FROM inventory'),
      transactions: scalar('SELECT COUNT(*) AS n FROM transactions'),
      caseOpens: scalar("SELECT COUNT(*) AS n FROM transactions WHERE label LIKE 'Открытие кейса:%'")
    },
    games: {
      played: scalar("SELECT COUNT(*) AS n FROM game_events WHERE outcome IN ('win','loss')") + scalar('SELECT COUNT(*) AS n FROM room_rounds'),
      outcomes: db.prepare("SELECT outcome,COUNT(*) AS count FROM game_events WHERE outcome IN ('win','loss') GROUP BY outcome ORDER BY outcome").all(),
      byType: db.prepare("SELECT game,COUNT(*) AS count FROM game_events WHERE outcome IN ('win','loss') GROUP BY game ORDER BY game").all()
    },
    multiplayer: {
      activeRooms: scalar("SELECT COUNT(*) AS n FROM rooms WHERE status IN ('waiting','active')"),
      friends: Math.floor(scalar("SELECT COUNT(*) AS n FROM friends WHERE status='accepted'") / 2),
      messages: scalar('SELECT COUNT(*) AS n FROM room_messages'),
      rounds: scalar('SELECT COUNT(*) AS n FROM room_rounds')
    },
    donations: { paidCount: Number(paidDonations.n || 0), stars: Number(paidDonations.stars || 0) },
    popularInventorySkins: db.prepare('SELECT skin_id AS skinId,COUNT(*) AS owners FROM inventory GROUP BY skin_id ORDER BY owners DESC,skin_id LIMIT 10').all()
  };
}
async function createGithubBlob(bytes) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  if (content.length > 50 * 1024 * 1024) throw new Error('Файл резервной копии больше 50 МБ и не отправлен в GitHub.');
  return githubApi('POST', '/git/blobs', { content: content.toString('base64'), encoding: 'base64' });
}
async function backupDatabase() {
  if (!GITHUB_CONFIGURED || backupInProgress) return;
  backupInProgress = true;
  const snapshotPath = DB_FILE + '.backup';
  try {
    await db.backup(snapshotPath);
    const databaseBytes = fs.readFileSync(snapshotPath);
    const databaseHash = crypto.createHash('sha256').update(databaseBytes).digest('hex');
    const logText = createReadableLog();
    const logHash = crypto.createHash('sha256').update(logText).digest('hex');
    const statsText = JSON.stringify(createStatsSnapshot(), null, 2) + '\n';
    const statsHash = crypto.createHash('sha256').update(statsText).digest('hex');
    const head = await githubHead();
    const updates = [];
    if (databaseHash !== lastBackupHash) {
      const compressed = gzipSync(databaseBytes, { level: 9 });
      const blob = await createGithubBlob(compressed);
      updates.push({ path: GITHUB_DB_PATH, mode: '100644', type: 'blob', sha: blob.sha });
      console.log('Prepared compressed SQLite snapshot for GitHub (' + Math.ceil(compressed.length / 1024) + ' KB).');
    }
    if (logHash !== lastLogHash) {
      const blob = await createGithubBlob(logText);
      updates.push({ path: GITHUB_LOG_PATH, mode: '100644', type: 'blob', sha: blob.sha });
    }
    if (statsHash !== lastStatsHash) {
      const blob = await createGithubBlob(statsText);
      updates.push({ path: GITHUB_STATS_PATH, mode: '100644', type: 'blob', sha: blob.sha });
    }
    if (!updates.length) return;
    const tree = await githubApi('POST', '/git/trees', { base_tree: head.treeSha, tree: updates });
    const commit = await githubApi('POST', '/git/commits', {
      message: 'Refresh CS2 Market backup and statistics',
      tree: tree.sha
    });
    await githubApi('PATCH', `/git/refs/heads/${encodeURIComponent(GITHUB_BRANCH)}`, { sha: commit.sha, force: true });
    lastBackupHash = databaseHash;
    lastLogHash = logHash;
    lastStatsHash = statsHash;
    console.log('Latest database, player log and statistics are saved to the private GitHub repository.');
  } catch (error) {
    console.error('GitHub database/statistics backup failed:', error.message);
  } finally {
    try { fs.rmSync(snapshotPath, { force: true }); } catch {}
    backupInProgress = false;
  }
}

function ensureColumn(table,name,definition){const columns=db.pragma(`table_info(${table})`);if(!columns.some(column=>column.name===name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)}
ensureColumn('users','created_at',"TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'");ensureColumn('users','last_active','TEXT');ensureColumn('users','account_status',"TEXT NOT NULL DEFAULT 'active'");ensureColumn('users','warning_count','INTEGER NOT NULL DEFAULT 0');ensureColumn('users','premium_until','INTEGER NOT NULL DEFAULT 0');ensureColumn('users','profile_updated_at','INTEGER NOT NULL DEFAULT 0');ensureColumn('transactions','admin_id','TEXT');ensureColumn('transactions','reason','TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS game_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, telegram_id TEXT NOT NULL, game TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'started', wager REAL NOT NULL DEFAULT 0, payout REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(telegram_id,event_id));
CREATE TABLE IF NOT EXISTS admin_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id TEXT NOT NULL, target_id TEXT, action TEXT NOT NULL, old_value TEXT, new_value TEXT, reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS friends (user_id TEXT NOT NULL, friend_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,friend_id));
CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, join_code TEXT NOT NULL UNIQUE, creator_id TEXT NOT NULL, game_type TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'public', status TEXT NOT NULL DEFAULT 'waiting', max_players INTEGER NOT NULL DEFAULT 4, settings_json TEXT NOT NULL DEFAULT '{}', state_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_activity TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS room_players (room_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, left_at TEXT, PRIMARY KEY(room_id,user_id));
CREATE TABLE IF NOT EXISTS room_rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, round_no INTEGER NOT NULL, actor_id TEXT NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(room_id,round_no));
CREATE TABLE IF NOT EXISTS room_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, user_id TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS room_invites (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, invited_by TEXT NOT NULL, invited_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(room_id,invited_id));
CREATE TABLE IF NOT EXISTS donations (id TEXT PRIMARY KEY, payload TEXT NOT NULL UNIQUE, telegram_id TEXT NOT NULL, stars INTEGER NOT NULL, coins INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'support', premium_days INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', telegram_payment_charge_id TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, paid_at TEXT);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(last_active);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(telegram_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_room_activity ON rooms(status,last_activity);
CREATE INDEX IF NOT EXISTS idx_room_messages ON room_messages(room_id,id DESC);
`);
ensureColumn('donations','coins','INTEGER NOT NULL DEFAULT 0');ensureColumn('donations','kind',"TEXT NOT NULL DEFAULT 'support'");ensureColumn('donations','premium_days','INTEGER NOT NULL DEFAULT 0');
const skins = Object.create(null);
const CASE_RETURN_RATE=0.4,CASE_SELLBACK_RATE=0.9;
const caseDefinitions = [
 {id:'starter',name:'Бюджетный кейс',description:'Доступные скины с реальными рыночными ценами.',price:4.5,emoji:'⚡',glow:'#e8b638',match:s=>s.price<=5},
 {id:'ak47',name:'AK-47 Case',description:'Подборка скинов для AK-47.',price:8,emoji:'🔫',glow:'#dc5c58',match:s=>s.weapon==='AK-47'},
 {id:'awp',name:'AWP Case',description:'Снайперские скины для AWP.',price:12,emoji:'🎯',glow:'#7297ee',match:s=>s.weapon==='AWP'},
 {id:'m4a1',name:'M4A1-S Case',description:'Подборка скинов для M4A1-S.',price:10,emoji:'🛡️',glow:'#49bfa7',match:s=>s.weapon==='M4A1-S'},
 {id:'m4a4',name:'M4A4 Case',description:'Подборка скинов для M4A4.',price:10,emoji:'⚙️',glow:'#da9b45',match:s=>s.weapon==='M4A4'},
 {id:'pistol',name:'Pistol Case',description:'Пистолеты из разных коллекций.',price:7,emoji:'🔹',glow:'#9a72ec',match:s=>/pistol/i.test(s.category)},
 {id:'smg',name:'SMG Case',description:'Компактные скины для ближнего боя.',price:6,emoji:'💥',glow:'#ec6f9b',match:s=>/smg/i.test(s.category)},
 {id:'sniper',name:'Sniper Case',description:'Снайперские винтовки и редкие расцветки.',price:9,emoji:'🎯',glow:'#63a9d6',match:s=>/sniper/i.test(s.category)},
 {id:'rifle',name:'Rifle Case',description:'Винтовки из актуального каталога.',price:9,emoji:'🎖️',glow:'#85b85d',match:s=>/rifle/i.test(s.category)},
 {id:'knife',name:'Knife Case',description:'Ножи и другие редкие предметы.',price:55,emoji:'🔪',glow:'#65c8f5',match:s=>/knife|bayonet|dagger|karambit/i.test(s.weapon+' '+s.name)},
 {id:'classified',name:'Classified Case',description:'Засекреченные скины из разных коллекций.',price:14,emoji:'✦',glow:'#c05be5',match:s=>/classified/i.test(s.rarity)},
 {id:'restricted',name:'Restricted Case',description:'Запрещённые скины с актуальными лотами.',price:8,emoji:'◆',glow:'#8b79ef',match:s=>/restricted/i.test(s.rarity)},
 {id:'milspec',name:'Mil-Spec Case',description:'Армейские расцветки и недорогие находки.',price:5,emoji:'▣',glow:'#4e8de5',match:s=>/mil-spec/i.test(s.rarity)},
 {id:'neon',name:'Neon Case',description:'Яркие неоновые и цветные скины.',price:11,emoji:'🌈',glow:'#c34caa',match:s=>/neon|fade|hyper beast|printstream|asiimov/i.test(s.name)},
 {id:'elite',name:'Elite Case',description:'Ценные скины из верхней части каталога.',price:30,emoji:'✧',glow:'#a47aff',match:s=>/covert/i.test(s.rarity)||s.price>=30}
];
const SKIN_CATALOG_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json';
const SKIN_CATALOG_TTL = 24 * 60 * 60 * 1000;
const SKIN_PRICE_TTL = 5 * 60 * 1000;
const SKIN_PRICE_URL = 'https://api.skinport.com/v1/items?app_id=730&currency=EUR&tradable=0';
let catalogEntries = [];
let remoteSkinCatalog = [];
let marketCases = {};
let skinCatalogUpdatedAt = 0;
let skinPricesUpdatedAt = 0;
let skinPriceLastAttemptAt = 0;
let skinCatalogRefresh = null;
let skinPriceRefresh = null;
function normalizeMarketName(value) { return String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase(); }
function pickCasePool(list,limit=16) {
 const sorted=[...list].filter(s=>Number.isFinite(Number(s.price))&&Number(s.price)>0).sort((a,b)=>a.price-b.price||a.name.localeCompare(b.name));
 if(!sorted.length)return [];
 const count=Math.min(limit,sorted.length),pool=[];
 for(let i=0;i<count;i++)pool.push(sorted[count===1?0:Math.round(i*(sorted.length-1)/(count-1))].id);
 return [...new Set(pool)];
}
function rebuildMarketCases() {
 const pricedCatalog=remoteSkinCatalog.filter(s=>Number.isFinite(Number(s.price))&&Number(s.price)>0);
 if(!pricedCatalog.length){marketCases={};return}
 const marketMin=Math.min(...pricedCatalog.map(s=>Number(s.price))),marketMax=Math.max(...pricedCatalog.map(s=>Number(s.price)));
 const minimumCasePrice=Math.ceil(marketMin*CASE_SELLBACK_RATE/CASE_RETURN_RATE*100)/100,maximumCasePrice=Math.floor(marketMax*CASE_SELLBACK_RATE/CASE_RETURN_RATE*100)/100;
 marketCases=Object.fromEntries(caseDefinitions.map(definition=>{
  const price=minimumCasePrice<=maximumCasePrice?Math.max(minimumCasePrice,Math.min(maximumCasePrice,definition.price)):definition.price;
  const target=price*CASE_RETURN_RATE/CASE_SELLBACK_RATE,matches=pricedCatalog.filter(definition.match);
  const pool=pickCasePool(matches.length>=3?matches:pricedCatalog,16),included=new Set(pool);
  const lowerAnchor=pricedCatalog.filter(s=>Number(s.price)<=target).sort((a,b)=>b.price-a.price)[0];
  const upperAnchor=pricedCatalog.filter(s=>Number(s.price)>=target).sort((a,b)=>a.price-b.price)[0];
  if(lowerAnchor&&!included.has(lowerAnchor.id)){pool.push(lowerAnchor.id);included.add(lowerAnchor.id)}
  if(upperAnchor&&!included.has(upperAnchor.id))pool.push(upperAnchor.id);
  return [definition.id,{id:definition.id,name:definition.name,description:definition.description,price,returnRate:CASE_RETURN_RATE,sellbackRate:CASE_SELLBACK_RATE,emoji:definition.emoji,glow:definition.glow,pool}];
 }));
}
function chooseCaseDrop(skinIds,casePrice){
 const items=skinIds.map(id=>({id,price:Number(skins[id])})).filter(item=>Number.isFinite(item.price)&&item.price>0);
 if(!items.length)return null;
 const target=Number(casePrice)*CASE_RETURN_RATE/CASE_SELLBACK_RATE,min=Math.min(...items.map(x=>x.price)),max=Math.max(...items.map(x=>x.price));
 if(max-min<1e-9)return items[Math.floor(Math.random()*items.length)].id;
 if(target<=min+1e-9)return items.filter(item=>item.price===min)[Math.floor(Math.random()*items.filter(item=>item.price===min).length)].id;
 if(target>=max-1e-9)return items.filter(item=>item.price===max)[Math.floor(Math.random()*items.filter(item=>item.price===max).length)].id;
 const expected=theta=>{
  const scale=max-min,logs=items.map(item=>theta*(item.price-target)/scale),peak=Math.max(...logs);
  let weight=0,value=0;
  for(let i=0;i<items.length;i++){const current=Math.exp(logs[i]-peak);weight+=current;value+=current*items[i].price}
  return value/weight;
 };
 let low=-48,high=48;
 for(let i=0;i<64;i++){const mid=(low+high)/2;if(expected(mid)<target)low=mid;else high=mid}
 const theta=(low+high)/2,scale=max-min,logs=items.map(item=>theta*(item.price-target)/scale),peak=Math.max(...logs),weights=logs.map(log=>Math.exp(log-peak));
 let roll=Math.random()*weights.reduce((sum,weight)=>sum+weight,0);
 for(let i=0;i<items.length;i++){roll-=weights[i];if(roll<=0)return items[i].id}
 return items[items.length-1].id;
}
async function refreshSkinCatalog() {
 if(catalogEntries.length&&Date.now()-skinCatalogUpdatedAt<SKIN_CATALOG_TTL)return catalogEntries;
 if(skinCatalogRefresh)return skinCatalogRefresh;
 skinCatalogRefresh=(async()=>{
  try{
   const response=await fetch(SKIN_CATALOG_URL,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw new Error('catalog source returned '+response.status);
   const source=await response.json();
   if(!Array.isArray(source))throw new Error('catalog source returned invalid data');
   const imported=[],seenMarketNames=new Set();
   for(const item of source){
    if(!item?.id||!item?.name||!item?.image||!item?.weapon?.name)continue;
    const baseName=String(item.name),rarityName=String(item.rarity?.name||'Unknown');
    const rarity=/mil-spec/i.test(rarityName)?'Mil-Spec':rarityName;
    const wears=Array.isArray(item.wears)&&item.wears.length?item.wears:[{id:'standard',name:'Standard'}];
    for(const wearInfo of wears){
     const wear=String(wearInfo?.name||'Standard');
     const slug=(String(item.id)+'-'+String(wearInfo?.id||wear)).toLowerCase().replace(/[^a-z0-9-]+/g,'-');
     const marketHashName=wear==='Standard'?baseName:baseName+' ('+wear+')',marketKey=normalizeMarketName(marketHashName);
     if(seenMarketNames.has(marketKey))continue;
     seenMarketNames.add(marketKey);
     imported.push({id:'catalog-'+slug,name:baseName,weapon:String(item.weapon.name),category:String(item.category?.name||''),wear,rarity,emoji:/knife|bayonet|karambit|dagger/i.test(item.weapon.name)?'🔪':'🔫',glow:/^#[0-9a-f]{3,8}$/i.test(item.rarity?.color||'')?item.rarity.color:'#8297aa',image:String(item.image),marketHashName});
    }
   }
   if(!imported.length)throw new Error('catalog contained no usable weapon skins');
   catalogEntries=imported;
   skinCatalogUpdatedAt=Date.now();
   skinPricesUpdatedAt=0;
   console.log('Skin catalog refreshed: '+imported.length+' wear variants');
  }catch(error){console.warn('Skin catalog refresh failed:',error.message)}
  finally{skinCatalogRefresh=null}
  return catalogEntries;
 })();
 return skinCatalogRefresh;
}
async function refreshSkinPrices() {
 if(remoteSkinCatalog.length&&Date.now()-skinPricesUpdatedAt<SKIN_PRICE_TTL)return remoteSkinCatalog;
 if(skinPriceRefresh)return skinPriceRefresh;
 if(Date.now()-skinPriceLastAttemptAt<SKIN_PRICE_TTL)return remoteSkinCatalog;
 skinPriceLastAttemptAt=Date.now();
 skinPriceRefresh=(async()=>{
  try{
   if(!catalogEntries.length)return remoteSkinCatalog;
   const response=await fetch(SKIN_PRICE_URL,{headers:{'Accept':'application/json','Accept-Encoding':'br'},signal:AbortSignal.timeout(20000)});
   if(!response.ok)throw new Error('Skinport returned '+response.status);
   const rows=await response.json();
   if(!Array.isArray(rows))throw new Error('Skinport returned invalid price data');
   const prices=new Map();
   for(const row of rows){
    const key=normalizeMarketName(row?.market_hash_name),price=Number(row?.min_price),quantity=Number(row?.quantity||0);
    if(!key||quantity<1||!Number.isFinite(price)||price<=0)continue;
    const old=prices.get(key);
    if(!old||price<old.price)prices.set(key,{price,quantity:Number.isFinite(quantity)?quantity:0,marketUrl:String(row.item_page||'')});
   }
   const priced=[];
   for(const skin of catalogEntries){
    const listing=prices.get(normalizeMarketName(skin.marketHashName));
    if(!listing)continue;
    priced.push({...skin,price:listing.price,marketQuantity:listing.quantity,marketUrl:listing.marketUrl,priceSource:'Skinport'});
   }
   remoteSkinCatalog=priced;
   for(const id of Object.keys(skins))delete skins[id];
   for(const skin of remoteSkinCatalog)skins[skin.id]=skin.price;
   skinPricesUpdatedAt=Date.now();
   rebuildMarketCases();
   console.log('Skinport prices refreshed: '+priced.length+' active listings matched');
  }catch(error){console.warn('Skinport price refresh failed:',error.message)}
  finally{skinPriceRefresh=null}
  return remoteSkinCatalog;
 })();
 return skinPriceRefresh;
}
function validateTelegramInitData(initData) {
  if (!BOT_TOKEN) throw Object.assign(new Error('На сервере не настроен BOT_TOKEN.'), { status: 503 });
  if (!initData) throw Object.assign(new Error('Открой приложение через Telegram.'), { status: 401 });
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw Object.assign(new Error('Некорректные данные Telegram.'), { status: 401 });
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const a = Buffer.from(expected, 'hex'), b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b)) throw Object.assign(new Error('Проверка Telegram не пройдена.'), { status: 401 });
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Math.abs(Date.now()/1000 - authDate) > 86400) throw Object.assign(new Error('Данные Telegram устарели. Перезапусти приложение.'), { status: 401 });
  const user = JSON.parse(params.get('user') || '{}');
  if (!user.id) throw Object.assign(new Error('Не удалось определить Telegram-пользователя.'), { status: 401 });
  return user;
}
function auth(req,res,next){ try { req.tgUser=validateTelegramInitData(req.get('X-Telegram-Init-Data')||req.body?.initData); ensureUser(req.tgUser); const id=String(req.tgUser.id); db.prepare('UPDATE users SET last_active=CURRENT_TIMESTAMP WHERE telegram_id=?').run(id); const user=db.prepare('SELECT account_status FROM users WHERE telegram_id=?').get(id); if(user?.account_status==='blocked')return res.status(403).json({error:'Аккаунт заблокирован.'}); if(BOT_TOKEN&&CHANNEL_ID&&!telegramLoadedUsers.has(id)&&req.path!=='/api/login')return res.status(428).json({error:'Сначала загрузи профиль через /api/login.'}); next(); } catch(e){ res.status(e.status||401).json({error:e.message}); } }
function ensureUser(user){ const username = user.username || [user.first_name,user.last_name].filter(Boolean).join(' ') || 'PLAYER'; db.prepare('INSERT OR IGNORE INTO users(telegram_id,username,balance) VALUES(?,?,100)').run(String(user.id),username); db.prepare('UPDATE users SET username=? WHERE telegram_id=?').run(username,String(user.id)); }
function account(id){ const user=db.prepare('SELECT telegram_id,username,balance,last_bonus,premium_until FROM users WHERE telegram_id=?').get(id); const inventory=db.prepare('SELECT skin_id FROM inventory WHERE telegram_id=? ORDER BY rowid').all(id).map(x=>x.skin_id); const transactions=db.prepare('SELECT label,amount,created_at FROM transactions WHERE telegram_id=? ORDER BY id DESC LIMIT 30').all(id); return {user:{id:user.telegram_id,first_name:user.username},balance:user.balance,inventory,transactions,lastBonus:user.last_bonus,premiumUntil:Number(user.premium_until||0)}; }
let queueTelegramUserBackup=()=>{};
function record(id,label,amount,adminId=null,reason=null){db.prepare('INSERT INTO transactions(telegram_id,label,amount,admin_id,reason) VALUES(?,?,?,?,?)').run(id,label,amount,adminId,reason);queueTelegramUserBackup(String(id));}
const app=express();
const httpServer=createServer(app);
const io=new Server(httpServer,{cors:{origin:FRONTEND_ORIGIN==='*'?'*':FRONTEND_ORIGIN.split(',').map(x=>x.trim()),methods:['GET','POST']}});
const connectedUsers=new Map();
app.use(cors({origin:FRONTEND_ORIGIN==='*'?'*':FRONTEND_ORIGIN.split(',').map(x=>x.trim()),allowedHeaders:['Content-Type','X-Telegram-Init-Data']}));
app.use(express.json({limit:'32kb'}));
app.use(express.urlencoded({extended:false,limit:'32kb'}));
const frontendRoot = path.resolve(__dirname, '..');
// Render can host the mini app and its API on one origin; config.js points the client back here.
app.get('/config.js',(_req,res)=>res.set('Cache-Control','no-store').type('application/javascript').send('window.CS2_API_BASE = window.location.origin;'));
app.get('/',(_req,res)=>res.set('Cache-Control','no-store').sendFile(path.join(frontendRoot,'index.html')));
app.get('/index.html',(_req,res)=>res.set('Cache-Control','no-store').sendFile(path.join(frontendRoot,'index.html')));
app.get('/style.css',(_req,res)=>res.sendFile(path.join(frontendRoot,'style.css')));
app.get('/app.js',(_req,res)=>res.sendFile(path.join(frontendRoot,'app.js')));
app.use('/assets',express.static(path.join(frontendRoot,'assets'),{maxAge:'1d'}));
app.get('/health',(req,res)=>res.json({ok:true,service:'CS2 Market API'}));
app.get('/ping',(_req,res)=>res.status(200).send('OK'));
async function telegramApi(method,payload,timeoutMs=9000){if(!BOT_TOKEN)throw new Error('BOT_TOKEN не настроен.');const response=await fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/'+method,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(timeoutMs)});const data=await response.json().catch(()=>({}));if(!response.ok||!data.ok)throw new Error(data.description||('Telegram API: '+response.status));return data.result}
const channelBackupEnabled=Boolean(BOT_TOKEN&&CHANNEL_ID);
const telegramBackupIndex=Object.create(null),pendingTelegramUsers=new Set(),telegramProfileCache=new Map();
let pinnedIndexMessageId=null,telegramIndexLoaded=false,telegramFlushTimer=null,telegramFlushPromise=null,shuttingDown=false;
async function downloadTelegramJson(fileId){
 const file=await telegramApi('getFile',{file_id:fileId});
 if(Number(file.file_size)>20*1024*1024)throw new Error('Бэкап больше лимита Telegram Bot API для скачивания.');
 const response=await fetch('https://api.telegram.org/file/bot'+BOT_TOKEN+'/'+file.file_path,{signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error('Не удалось скачать файл бэкапа из Telegram: '+response.status);
 return JSON.parse(await response.text());
}
async function loadTelegramBackupIndex(){
 if(!channelBackupEnabled){console.warn('Telegram profile backups are disabled. Set BOT_TOKEN and CHANNEL_ID in Render.');return}
 const chat=await telegramApi('getChat',{chat_id:CHANNEL_ID}),pinned=chat.pinned_message;
 if(pinned?.document?.file_name==='index.json'){
  const loaded=await downloadTelegramJson(pinned.document.file_id);
  for(const [userId,fileId] of Object.entries(loaded||{}))if(/^\d+$/.test(String(userId))&&typeof fileId==='string')telegramBackupIndex[userId]=fileId;
  pinnedIndexMessageId=pinned.message_id;
  console.log('Loaded pinned Telegram backup index for '+Object.keys(telegramBackupIndex).length+' players.');
 }else console.log('No pinned index.json exists in the Telegram backup channel yet.');
 telegramIndexLoaded=true;
}
async function sendTelegramDocument(fileName,content){
 const form=new FormData();form.append('chat_id',CHANNEL_ID);form.append('disable_notification','true');
 form.append('document',new Blob([JSON.stringify(content)],{type:'application/json'}),fileName);
 const response=await fetch('https://api.telegram.org/bot'+BOT_TOKEN+'/sendDocument',{method:'POST',body:form,signal:AbortSignal.timeout(25000)});
 const data=await response.json().catch(()=>({}));if(!response.ok||!data.ok)throw new Error(data.description||('Telegram sendDocument: '+response.status));return data.result;
}
function captureTelegramUserProfile(userId){
 const user=db.prepare('SELECT telegram_id,username,balance,last_bonus,premium_until,created_at,last_active,account_status,warning_count,profile_updated_at FROM users WHERE telegram_id=?').get(userId);
 if(!user)return null;
 return {user,inventory:db.prepare('SELECT skin_id FROM inventory WHERE telegram_id=? ORDER BY rowid').all(userId).map(row=>row.skin_id),transactions:db.prepare('SELECT label,amount,created_at,admin_id,reason FROM transactions WHERE telegram_id=? ORDER BY id').all(userId),games:db.prepare('SELECT event_id,game,outcome,wager,payout,created_at,updated_at FROM game_events WHERE telegram_id=? ORDER BY id').all(userId),donations:db.prepare('SELECT id,payload,telegram_id,stars,coins,kind,premium_days,status,telegram_payment_charge_id,created_at,paid_at FROM donations WHERE telegram_id=? ORDER BY created_at').all(userId),adminActions:db.prepare('SELECT admin_id,action,old_value,new_value,reason,created_at FROM admin_logs WHERE target_id=? ORDER BY id').all(userId)};
}
async function publishTelegramBackupIndex(){
 const oldMessageId=pinnedIndexMessageId;
 const message=await sendTelegramDocument('index.json',telegramBackupIndex);
 await telegramApi('pinChatMessage',{chat_id:CHANNEL_ID,message_id:message.message_id,disable_notification:true});
 pinnedIndexMessageId=message.message_id;
 if(oldMessageId&&oldMessageId!==message.message_id)try{await telegramApi('unpinChatMessage',{chat_id:CHANNEL_ID,message_id:oldMessageId})}catch(error){console.warn('Could not unpin previous Telegram backup index:',error.message)}
}
function scheduleTelegramBackupFlush(){
 if(telegramFlushTimer||shuttingDown||!channelBackupEnabled)return;
 telegramFlushTimer=setTimeout(()=>{telegramFlushTimer=null;void flushTelegramBackupQueue(false)},5000);telegramFlushTimer.unref?.();
}
async function flushTelegramBackupQueue(force=false){
 if(!channelBackupEnabled||!pendingTelegramUsers.size)return true;
 if(!telegramIndexLoaded){console.warn('Telegram backup index is not ready; queued player snapshots are waiting.');if(!shuttingDown)scheduleTelegramBackupFlush();return false}
 if(telegramFlushPromise){await telegramFlushPromise;return pendingTelegramUsers.size?flushTelegramBackupQueue(force):true}
 if(telegramFlushTimer){clearTimeout(telegramFlushTimer);telegramFlushTimer=null}
 const ids=[...pendingTelegramUsers].slice(0,force?20:5);ids.forEach(id=>pendingTelegramUsers.delete(id));
 const current=(async()=>{
  try{
   const users=ids.map(captureTelegramUserProfile).filter(Boolean);if(!users.length)return true;
   const batchName='batch_'+Date.now()+'.json',message=await sendTelegramDocument(batchName,{createdAt:new Date().toISOString(),users});
   for(const profile of users)telegramBackupIndex[String(profile.user.telegram_id)]=message.document.file_id;
   await publishTelegramBackupIndex();
   console.log('Telegram profile backup saved for '+users.length+' players in '+batchName+'.');return true;
  }catch(error){for(const id of ids)pendingTelegramUsers.add(id);console.error('Telegram profile backup failed:',error.message);return false}
 })();
 telegramFlushPromise=current;const success=await current;if(telegramFlushPromise===current)telegramFlushPromise=null;
 if(pendingTelegramUsers.size&&!shuttingDown){if(success&&pendingTelegramUsers.size>=5)queueMicrotask(()=>void flushTelegramBackupQueue(false));else scheduleTelegramBackupFlush()}
 return success;
}
function enqueueTelegramUser(userId){
 if(!channelBackupEnabled)return;
 const id=String(userId);db.prepare('UPDATE users SET profile_updated_at=? WHERE telegram_id=?').run(Date.now(),id);pendingTelegramUsers.add(id);
 if(shuttingDown)return;
 if(pendingTelegramUsers.size>=5)queueMicrotask(()=>void flushTelegramBackupQueue(false));else scheduleTelegramBackupFlush();
}
function queueUsersMissingFromTelegramIndex(){if(!channelBackupEnabled||!telegramIndexLoaded)return;for(const row of db.prepare('SELECT telegram_id FROM users').all())if(!telegramBackupIndex[String(row.telegram_id)])enqueueTelegramUser(String(row.telegram_id));}
queueTelegramUserBackup=enqueueTelegramUser;
function restoreTelegramUserProfile(profile,currentTelegramUser){
 const user=profile?.user;if(!user||String(user.telegram_id)!==String(currentTelegramUser.id))return false;
 const local=db.prepare('SELECT profile_updated_at FROM users WHERE telegram_id=?').get(String(user.telegram_id)),remoteUpdated=Number(user.profile_updated_at)||0;
 if(local&&Number(local.profile_updated_at||0)>=remoteUpdated&&Number(local.profile_updated_at||0)>0){queueTelegramUserBackup(String(user.telegram_id));return false;}
 const restore=db.transaction(()=>{
  db.prepare(`INSERT INTO users(telegram_id,username,balance,last_bonus,premium_until,created_at,last_active,account_status,warning_count,profile_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,balance=excluded.balance,last_bonus=excluded.last_bonus,premium_until=excluded.premium_until,created_at=excluded.created_at,last_active=excluded.last_active,account_status=excluded.account_status,warning_count=excluded.warning_count,profile_updated_at=excluded.profile_updated_at`).run(String(user.telegram_id),currentTelegramUser.username||currentTelegramUser.first_name||user.username,Number(user.balance)||0,user.last_bonus||null,Number(user.premium_until)||0,user.created_at||new Date().toISOString(),new Date().toISOString(),user.account_status||'active',Number(user.warning_count)||0,remoteUpdated);
  db.prepare('DELETE FROM inventory WHERE telegram_id=?').run(String(user.telegram_id));for(const skin of profile.inventory||[])db.prepare('INSERT OR IGNORE INTO inventory(telegram_id,skin_id) VALUES(?,?)').run(String(user.telegram_id),String(skin));
  db.prepare('DELETE FROM transactions WHERE telegram_id=?').run(String(user.telegram_id));for(const item of profile.transactions||[])db.prepare('INSERT INTO transactions(telegram_id,label,amount,created_at,admin_id,reason) VALUES(?,?,?,?,?,?)').run(String(user.telegram_id),item.label,Number(item.amount)||0,item.created_at||new Date().toISOString(),item.admin_id||null,item.reason||null);
  db.prepare('DELETE FROM game_events WHERE telegram_id=?').run(String(user.telegram_id));for(const game of profile.games||[])db.prepare('INSERT OR REPLACE INTO game_events(event_id,telegram_id,game,outcome,wager,payout,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(game.event_id,String(user.telegram_id),game.game,game.outcome,Number(game.wager)||0,Number(game.payout)||0,game.created_at||new Date().toISOString(),game.updated_at||new Date().toISOString());
  for(const donation of profile.donations||[])db.prepare('INSERT OR IGNORE INTO donations(id,payload,telegram_id,stars,coins,kind,premium_days,status,telegram_payment_charge_id,created_at,paid_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(donation.id,donation.payload,String(user.telegram_id),donation.stars,donation.coins,donation.kind,donation.premium_days,donation.status,donation.telegram_payment_charge_id,donation.created_at,donation.paid_at);
  db.prepare('DELETE FROM admin_logs WHERE target_id=?').run(String(user.telegram_id));for(const action of profile.adminActions||[])db.prepare('INSERT INTO admin_logs(admin_id,target_id,action,old_value,new_value,reason,created_at) VALUES(?,?,?,?,?,?,?)').run(action.admin_id,String(user.telegram_id),action.action,action.old_value,action.new_value,action.reason,action.created_at||new Date().toISOString());
  db.prepare('UPDATE users SET username=?,last_active=CURRENT_TIMESTAMP WHERE telegram_id=?').run(currentTelegramUser.username||currentTelegramUser.first_name||user.username,String(user.telegram_id));
 });restore();return true;
}
async function restoreTelegramUserFromChannel(userId,telegramUser){
 if(!channelBackupEnabled)return false;
 if(!telegramIndexLoaded)throw new Error('Индекс бэкапа Telegram пока недоступен. Попробуй снова через минуту.');
 const fileId=telegramBackupIndex[String(userId)];if(!fileId)return false;
 let batch=telegramProfileCache.get(fileId);if(!batch){batch=await downloadTelegramJson(fileId);telegramProfileCache.clear();telegramProfileCache.set(fileId,batch)}
 const profile=(batch.users||[]).find(item=>String(item.user?.telegram_id)===String(userId));if(!profile)throw new Error('Профиль не найден в файле бэкапа Telegram.');
 return restoreTelegramUserProfile(profile,telegramUser);
}
const donationPackages=Object.freeze({15:10000,25:50000});
app.post('/api/donate/invoice',auth,async(req,res)=>{
 const stars=Number(req.body?.stars),coins=donationPackages[stars];
 if(!coins)return res.status(400).json({error:'Выбери пакет виртуальных монет.'});
 if(!BOT_TOKEN)return res.status(503).json({error:'Для Telegram Stars не настроен BOT_TOKEN.'});
 const donationId=crypto.randomUUID(),payload='cs2d:'+donationId,userId=String(req.tgUser.id);
 db.prepare("INSERT INTO donations(id,payload,telegram_id,stars,coins,kind) VALUES(?,?,?,?,?,'coins')").run(donationId,payload,userId,stars,coins);
 try{
  const coinLabel=coins.toLocaleString('ru-RU')+' виртуальных монет';
  const invoiceLink=await telegramApi('createInvoiceLink',{title:'Монеты CS2 Market',description:'Пакет '+coinLabel+'. Только виртуальные кредиты без денежной стоимости.',payload,currency:'XTR',prices:[{label:coinLabel,amount:stars}]},12000);
  res.json({invoiceLink,stars,coins});
 }catch(error){
  db.prepare("UPDATE donations SET status='failed' WHERE id=? AND status='pending'").run(donationId);
  console.error('Donation invoice creation failed:',error.message);
  res.status(502).json({error:'Не удалось создать счёт Telegram Stars. Попробуй позже.'});
 }
});
app.post('/api/premium/invoice',auth,async(req,res)=>{
 if(!BOT_TOKEN)return res.status(503).json({error:'Для Telegram Stars не настроен BOT_TOKEN.'});
 const stars=15,premiumDays=30,donationId=crypto.randomUUID(),payload='cs2p:'+donationId,userId=String(req.tgUser.id);
 db.prepare("INSERT INTO donations(id,payload,telegram_id,stars,coins,kind,premium_days) VALUES(?,?,?, ?,0,'premium',?)").run(donationId,payload,userId,stars,premiumDays);
 try{
  const invoiceLink=await telegramApi('createInvoiceLink',{title:'Premium на 30 дней',description:'30 дней Premium-доступа в CS2 Market.',payload,currency:'XTR',prices:[{label:'Premium · 30 дней',amount:stars}]},12000);
  res.json({invoiceLink,stars,premiumDays});
 }catch(error){
  db.prepare("UPDATE donations SET status='failed' WHERE id=? AND status='pending'").run(donationId);
  console.error('Premium invoice creation failed:',error.message);
  res.status(502).json({error:'Не удалось создать счёт Premium в Telegram Stars. Попробуй позже.'});
 }
});
function matchesWebhookSecret(received){if(!TELEGRAM_WEBHOOK_SECRET||!received)return false;const expected=Buffer.from(TELEGRAM_WEBHOOK_SECRET),actual=Buffer.from(received);return expected.length===actual.length&&crypto.timingSafeEqual(expected,actual)}
app.post('/api/telegram/webhook',async(req,res)=>{
 if(!matchesWebhookSecret(req.get('X-Telegram-Bot-Api-Secret-Token')))return res.sendStatus(401);
 try{
  const update=req.body||{},query=update.pre_checkout_query;
  if(query){
   const order=db.prepare("SELECT telegram_id,stars FROM donations WHERE payload=? AND status='pending'").get(String(query.invoice_payload||''));
   const valid=Boolean(order&&String(query.from?.id||'')===order.telegram_id&&query.currency==='XTR'&&Number(query.total_amount)===order.stars);
   await telegramApi('answerPreCheckoutQuery',{pre_checkout_query_id:query.id,ok:valid,...(valid?{}:{error_message:'Счёт не найден или уже обработан. Создай новый пакет монет.'})},7000);
  }
  const payment=update.message?.successful_payment;
  if(payment){
   const userId=String(update.message.from?.id||''),chargeId=String(payment.telegram_payment_charge_id||'');
   const order=db.prepare("SELECT id,telegram_id,stars,coins,kind,premium_days,status FROM donations WHERE payload=?").get(String(payment.invoice_payload||''));
   if(order&&order.status==='pending'&&order.telegram_id===userId&&payment.currency==='XTR'&&Number(payment.total_amount)===order.stars&&chargeId){
    const finalize=db.transaction(()=>{
     const changed=db.prepare("UPDATE donations SET status='paid',telegram_payment_charge_id=?,paid_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").run(chargeId,order.id);
     if(!changed.changes)return false;
     if(order.kind==='coins'&&Number(order.coins)>0){
      const credited=db.prepare('UPDATE users SET balance=balance+? WHERE telegram_id=?').run(Number(order.coins),userId);
      if(!credited.changes)throw Error('Пользователь для зачисления монет не найден.');
      record(userId,'Покупка '+Number(order.coins).toLocaleString('ru-RU')+' виртуальных монет за '+order.stars+' ⭐',Number(order.coins));
     }else if(order.kind==='premium'&&Number(order.premium_days)>0){
      const now=Date.now(),duration=Number(order.premium_days)*24*60*60*1000;
      const activated=db.prepare('UPDATE users SET premium_until=MAX(premium_until,?)+? WHERE telegram_id=?').run(now,duration,userId);
      if(!activated.changes)throw Error('Пользователь для активации Premium не найден.');
      record(userId,'Premium на '+Number(order.premium_days)+' дней за '+order.stars+' ⭐',0);
     }
     return true;
    });
    if(finalize())console.log('Telegram Stars payment recorded: '+order.stars+' XTR, kind='+order.kind+', for '+userId);
    else console.warn('Ignored duplicate Telegram Stars payment update for '+order.id);
   }else console.warn('Ignored unmatched Telegram Stars payment update');
  }
  res.sendStatus(200);
 }catch(error){console.error('Telegram payment webhook failed:',error.message);res.sendStatus(500)}
});
app.get('/api/skins',auth,async(req,res)=>{
 await refreshSkinCatalog();
 const catalog=await refreshSkinPrices(),userId=String(req.tgUser.id);
 const metadataById=new Map(catalogEntries.map(item=>[String(item.id),item]));
 const pricedById=new Map(catalog.map(item=>[String(item.id),item]));
 const ownedIds=db.prepare('SELECT skin_id FROM inventory WHERE telegram_id=? ORDER BY rowid').all(userId).map(row=>String(row.skin_id));
 const ownedSkins=ownedIds.map(id=>{
  const metadata=metadataById.get(id)||pricedById.get(id);
  if(!metadata)return {id,name:'Сохранённый предмет',weapon:'CS2 ITEM',wear:'Предмет сохранён в аккаунте',rarity:'Сохранён',emoji:'🔫',glow:'#8297aa',image:'',price:0,available:false};
  const priced=pricedById.get(id);
  return {...metadata,id,price:priced?Number(priced.price):0,available:Boolean(priced)};
 });
 res.set('Cache-Control','no-store').json({skins:catalog,ownedSkins,cases:Object.values(marketCases),updatedAt:skinCatalogUpdatedAt||null,priceUpdatedAt:skinPricesUpdatedAt||null,priceSource:'Skinport minimum active listing price · EUR'});
});
app.post('/api/login',auth,async(req,res)=>{try{const userId=String(req.tgUser.id);if(channelBackupEnabled)await restoreTelegramUserFromChannel(userId,req.tgUser);const current=db.prepare('SELECT account_status FROM users WHERE telegram_id=?').get(userId);if(current?.account_status==='blocked')return res.status(403).json({error:'Аккаунт заблокирован.'});telegramLoadedUsers.add(userId);queueTelegramUserBackup(userId);res.set('Cache-Control','no-store').json(account(userId))}catch(error){console.error('Telegram profile restore failed:',error.message);res.status(503).json({error:'Не удалось загрузить профиль из резервного канала. Попробуй ещё раз.'})}});
app.post('/api/logout',auth,(req,res)=>{const id=String(req.tgUser.id);queueTelegramUserBackup(id);io.in('user:'+id).disconnectSockets(true);res.sendStatus(204)});
app.get('/api/me',auth,(req,res)=>{ensureUser(req.tgUser);res.json(account(String(req.tgUser.id)));});
app.post('/api/buy',auth,(req,res)=>{ensureUser(req.tgUser);const id=String(req.tgUser.id),skin=req.body?.skinId,price=skins[skin];if(!price)return res.status(400).json({error:'Неизвестный скин.'});const tx=db.transaction(()=>{const u=db.prepare('SELECT balance FROM users WHERE telegram_id=?').get(id);if(db.prepare('SELECT 1 FROM inventory WHERE telegram_id=? AND skin_id=?').get(id,skin))throw Error('Этот скин уже есть.');if(u.balance<price)throw Error('Недостаточно виртуальных кредитов.');db.prepare('UPDATE users SET balance=balance-? WHERE telegram_id=?').run(price,id);db.prepare('INSERT INTO inventory(telegram_id,skin_id) VALUES(?,?)').run(id,skin);record(id,'Покупка: '+skin,-price);});try{tx();res.json(account(id));}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/sell',auth,(req,res)=>{ensureUser(req.tgUser);const id=String(req.tgUser.id),skin=req.body?.skinId,price=skins[skin];if(!price)return res.status(400).json({error:'Неизвестный скин.'});const tx=db.transaction(()=>{const del=db.prepare('DELETE FROM inventory WHERE telegram_id=? AND skin_id=?').run(id,skin);if(!del.changes)throw Error('Предмет не найден в инвентаре.');const value=Math.round(price*.9*100)/100;db.prepare('UPDATE users SET balance=balance+? WHERE telegram_id=?').run(value,id);record(id,'Продажа: '+skin,value);});try{tx();res.json(account(id));}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/upgrade',auth,(req,res)=>{ensureUser(req.tgUser);const id=String(req.tgUser.id),a=req.body?.sourceId,b=req.body?.targetId;if(!skins[a]||!skins[b]||skins[b]<=skins[a])return res.status(400).json({error:'Выбери цель дороже исходного скина.'});const chance=Math.max(1,Math.min(90,Math.round(skins[a]/skins[b]*75)));const success=Math.random()*100<chance;const tx=db.transaction(()=>{if(db.prepare('SELECT 1 FROM inventory WHERE telegram_id=? AND skin_id=?').get(id,b))throw Error('Целевой скин уже есть в инвентаре. Выбери другой.');const del=db.prepare('DELETE FROM inventory WHERE telegram_id=? AND skin_id=?').run(id,a);if(!del.changes)throw Error('Исходный предмет не найден.');if(success)db.prepare('INSERT INTO inventory(telegram_id,skin_id) VALUES(?,?)').run(id,b);record(id,success?'Апгрейд: '+b:'Неудачный апгрейд: '+a,0);});try{tx();res.json({...account(id),success,chance});}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/open-case',auth,(req,res)=>{
 ensureUser(req.tgUser);
 const id=String(req.tgUser.id),caseId=String(req.body?.caseId||''),c=marketCases[caseId];
 if(!c)return res.status(400).json({error:'Неизвестный кейс.'});
 if(!Array.isArray(c.pool)||!c.pool.length)return res.status(503).json({error:'Для этого кейса пока нет предметов с активными рыночными лотами.'});
 const drop=chooseCaseDrop(c.pool,c.price);if(!drop)return res.status(503).json({error:'Не удалось выбрать предмет для кейса.'});
 try{
  const duplicateCredit=db.transaction(()=>{
   const user=db.prepare('SELECT balance FROM users WHERE telegram_id=?').get(id);
   if(user.balance<c.price)throw Error('Недостаточно виртуальных кредитов.');
   const duplicate=Boolean(db.prepare('SELECT 1 FROM inventory WHERE telegram_id=? AND skin_id=?').get(id,drop));
   const credit=duplicate?Math.round(Number(skins[drop])*CASE_SELLBACK_RATE*100)/100:0;
   db.prepare('UPDATE users SET balance=balance-? WHERE telegram_id=?').run(c.price,id);
   record(id,'Открытие кейса: '+caseId,-c.price);
   if(duplicate){db.prepare('UPDATE users SET balance=balance+? WHERE telegram_id=?').run(credit,id);record(id,'Компенсация дубликата кейса: '+drop,credit)}
   else db.prepare('INSERT INTO inventory(telegram_id,skin_id) VALUES(?,?)').run(id,drop);
   return credit;
  })();
  res.json({...account(id),drop,duplicateCredit});
 }catch(e){res.status(400).json({error:e.message})}
});
app.post('/api/daily-bonus',auth,(req,res)=>{ensureUser(req.tgUser);const id=String(req.tgUser.id),today=new Date().toISOString().slice(0,10);const tx=db.transaction(()=>{const u=db.prepare('SELECT last_bonus FROM users WHERE telegram_id=?').get(id);if(u.last_bonus===today)throw Error('Ежедневный бонус уже получен.');db.prepare('UPDATE users SET balance=balance+50,last_bonus=? WHERE telegram_id=?').run(today,id);record(id,'Ежедневный бонус',50);});try{tx();res.json(account(id));}catch(e){res.status(400).json({error:e.message});}});
function requireAdmin(req,res,next){if(!ADMIN_IDS.has(String(req.tgUser?.id||'')))return res.status(403).json({error:'Доступ только для администраторов.'});next()}
function adminLog(adminId,targetId,action,oldValue,newValue,reason){db.prepare('INSERT INTO admin_logs(admin_id,target_id,action,old_value,new_value,reason) VALUES(?,?,?,?,?,?)').run(adminId,targetId,action,oldValue==null?null:JSON.stringify(oldValue),newValue==null?null:JSON.stringify(newValue),reason)}
function isOnline(id){return connectedUsers.has(String(id))}
function playerPresence(id){if(!isOnline(id))return 'offline';if(!db.prepare("SELECT 1 FROM room_players rp JOIN rooms r ON r.id=rp.room_id WHERE rp.user_id=? AND rp.left_at IS NULL AND r.status IN ('waiting','active') LIMIT 1").get(String(id)))return 'online';return 'in_game'}
function roomInfo(roomId){const room=db.prepare('SELECT * FROM rooms WHERE id=?').get(roomId);if(!room)return null;const members=db.prepare('SELECT u.telegram_id,u.username,rp.joined_at FROM room_players rp JOIN users u ON u.telegram_id=rp.user_id WHERE rp.room_id=? AND rp.left_at IS NULL ORDER BY rp.joined_at').all(roomId).map(x=>({...x,presence:playerPresence(x.telegram_id)}));const messages=db.prepare('SELECT m.id,m.user_id,u.username,m.message,m.created_at FROM room_messages m JOIN users u ON u.telegram_id=m.user_id WHERE m.room_id=? ORDER BY m.id DESC LIMIT 60').all(roomId).reverse();const rounds=db.prepare('SELECT round_no,actor_id,state_json,created_at FROM room_rounds WHERE room_id=? ORDER BY round_no DESC LIMIT 30').all(roomId).reverse();let settings={},state={};try{settings=JSON.parse(room.settings_json)}catch{}try{state=JSON.parse(room.state_json)}catch{}return {id:room.id,joinCode:room.join_code,creatorId:room.creator_id,gameType:room.game_type,visibility:room.visibility,status:room.status,maxPlayers:room.max_players,settings,members,messages,rounds,state,createdAt:room.created_at}}
function joinRoom(roomId,userId){const tx=db.transaction(()=>{const room=db.prepare('SELECT * FROM rooms WHERE id=?').get(roomId);if(!room||!['waiting','active'].includes(room.status))throw Error('Комната больше не доступна.');const existing=db.prepare('SELECT left_at FROM room_players WHERE room_id=? AND user_id=?').get(roomId,userId);if(existing&&!existing.left_at)return;const count=db.prepare('SELECT COUNT(*) AS n FROM room_players WHERE room_id=? AND left_at IS NULL').get(roomId).n;if(count>=room.max_players)throw Error('Комната заполнена.');db.prepare('INSERT INTO room_players(room_id,user_id) VALUES(?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET joined_at=CURRENT_TIMESTAMP,left_at=NULL').run(roomId,userId);const after=count+1;db.prepare("UPDATE rooms SET status=?,updated_at=CURRENT_TIMESTAMP,last_activity=CURRENT_TIMESTAMP WHERE id=?").run(after>=2?'active':'waiting',roomId)});tx();io.emit('presence:update',{userId,status:playerPresence(userId)});return roomInfo(roomId)}
function closeRoom(roomId){const members=db.prepare('SELECT user_id FROM room_players WHERE room_id=? AND left_at IS NULL').all(roomId);db.prepare("UPDATE rooms SET status='closed',updated_at=CURRENT_TIMESTAMP,last_activity=CURRENT_TIMESTAMP WHERE id=? AND status IN ('waiting','active')").run(roomId);db.prepare('UPDATE room_players SET left_at=CURRENT_TIMESTAMP WHERE room_id=? AND left_at IS NULL').run(roomId);for(const member of members)io.emit('presence:update',{userId:member.user_id,status:playerPresence(member.user_id)});io.to(`room:${roomId}`).emit('room:closed',{roomId})}
app.get('/api/admin/me',auth,(req,res)=>res.json({isAdmin:ADMIN_IDS.has(String(req.tgUser.id)),userId:String(req.tgUser.id)}));
app.get('/api/admin/dashboard',auth,requireAdmin,(req,res)=>{try{const players=db.prepare('SELECT COUNT(*) AS n FROM users').get().n;const last24=db.prepare("SELECT COUNT(*) AS n FROM users WHERE last_active>=datetime('now','-24 hours')").get().n;const newRegs=db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at>=datetime('now','-24 hours')").get().n;const rooms=db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE status IN ('waiting','active')").get().n;const games=db.prepare("SELECT (SELECT COUNT(*) FROM game_events WHERE outcome IN ('win','loss'))+(SELECT COUNT(*) FROM room_rounds) AS n").get().n;const coins=db.prepare('SELECT COALESCE(SUM(balance),0) AS n FROM users').get().n;const recentEvents=db.prepare("SELECT type,description,player_id,created_at FROM (SELECT 'transaction' AS type,label AS description,telegram_id AS player_id,created_at FROM transactions UNION ALL SELECT 'game',game||' · '||outcome,telegram_id,created_at FROM game_events WHERE outcome!='started' UNION ALL SELECT 'admin',action||' · '||reason,target_id,created_at FROM admin_logs) ORDER BY created_at DESC LIMIT 18").all();const dbStatus=db.prepare('PRAGMA quick_check').get()?.quick_check||'unknown';res.json({playersTotal:players,onlineNow:connectedUsers.size,last24h:last24,newRegistrations:newRegs,activeRooms:rooms,gamesPlayed:games,virtualCoins:coins,recentEvents,backend:{status:'online',database:dbStatus,uptimeSeconds:Math.round(process.uptime())}})}catch(e){res.status(500).json({error:'Не удалось загрузить статистику: '+e.message})}});
app.get('/api/admin/players',auth,requireAdmin,(req,res)=>{const q=String(req.query.q||'').trim().slice(0,80),status=String(req.query.status||'all'),sort=String(req.query.sort||'created_at'),dir=String(req.query.dir||'desc').toLowerCase()==='asc'?'ASC':'DESC',page=Math.max(1,Number(req.query.page)||1),limit=Math.min(100,Math.max(10,Number(req.query.limit)||30)),sortColumn={created_at:'created_at',balance:'balance',last_active:'last_active',username:'username'}[sort]||'created_at';const params=[];let where='1=1';if(q){where+=' AND (telegram_id LIKE ? OR username LIKE ?)';params.push('%'+q+'%','%'+q+'%')}if(['active','blocked'].includes(status)){where+=' AND account_status=?';params.push(status)}const total=db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${where}`).get(...params).n;const rows=db.prepare(`SELECT telegram_id,username,balance,created_at,last_active,account_status,warning_count FROM users WHERE ${where} ORDER BY ${sortColumn} ${dir} LIMIT ? OFFSET ?`).all(...params,limit,(page-1)*limit).map(u=>({...u,presence:playerPresence(u.telegram_id)}));res.json({players:rows,total,page,limit})});
app.get('/api/admin/players/:id',auth,requireAdmin,(req,res)=>{const id=String(req.params.id);const user=db.prepare('SELECT telegram_id,username,balance,created_at,last_active,account_status,warning_count FROM users WHERE telegram_id=?').get(id);if(!user)return res.status(404).json({error:'Игрок не найден.'});const inventory=db.prepare('SELECT skin_id FROM inventory WHERE telegram_id=? ORDER BY rowid').all(id).map(x=>x.skin_id);const transactions=db.prepare('SELECT id,label,amount,admin_id,reason,created_at FROM transactions WHERE telegram_id=? ORDER BY id DESC LIMIT 50').all(id);const games=db.prepare('SELECT event_id,game,outcome,wager,payout,created_at,updated_at FROM game_events WHERE telegram_id=? ORDER BY id DESC LIMIT 50').all(id);const results=db.prepare("SELECT SUM(outcome='win') AS wins,SUM(outcome='loss') AS losses FROM game_events WHERE telegram_id=?").get(id);const actions=db.prepare('SELECT admin_id,action,old_value,new_value,reason,created_at FROM admin_logs WHERE target_id=? ORDER BY id DESC LIMIT 50').all(id);res.json({player:{...user,presence:playerPresence(id)},inventory,transactions,games,stats:{wins:results.wins||0,losses:results.losses||0},adminActions:actions})});
app.post('/api/admin/players/:id/action',auth,requireAdmin,(req,res)=>{const adminId=String(req.tgUser.id),targetId=String(req.params.id),action=String(req.body?.action||''),reason=String(req.body?.reason||'').trim().slice(0,500),amount=Math.round(Number(req.body?.amount)*100)/100;const target=db.prepare('SELECT telegram_id,balance,account_status,warning_count FROM users WHERE telegram_id=?').get(targetId);if(!target)return res.status(404).json({error:'Игрок не найден.'});if(!reason)return res.status(400).json({error:'Укажи причину действия.'});if((action==='block'||(action==='status'&&req.body?.status==='blocked'))&&adminId===targetId)return res.status(400).json({error:'Нельзя заблокировать собственный аккаунт.'});try{const tx=db.transaction(()=>{let oldValue,newValue;if(action==='block'||action==='unblock'){oldValue=target.account_status;newValue=action==='block'?'blocked':'active';db.prepare('UPDATE users SET account_status=? WHERE telegram_id=?').run(newValue,targetId)}else if(action==='warn'){oldValue=target.warning_count;newValue=oldValue+1;db.prepare('UPDATE users SET warning_count=? WHERE telegram_id=?').run(newValue,targetId)}else if(action==='status'){const status=String(req.body?.status||'');if(!['active','blocked'].includes(status))throw Error('Неизвестный статус аккаунта.');oldValue=target.account_status;newValue=status;db.prepare('UPDATE users SET account_status=? WHERE telegram_id=?').run(status,targetId)}else if(action==='add_coins'||action==='remove_coins'){if(!Number.isFinite(amount)||amount<=0)throw Error('Укажи положительное количество монет.');const delta=action==='add_coins'?amount:-amount;oldValue=target.balance;newValue=Math.round((oldValue+delta)*100)/100;if(newValue<0)throw Error('На балансе недостаточно виртуальных монет.');db.prepare('UPDATE users SET balance=? WHERE telegram_id=?').run(newValue,targetId);record(targetId,`ADMIN ${action==='add_coins'?'начисление':'списание'}: ${reason}`,delta,adminId,reason)}else throw Error('Недопустимое действие.');adminLog(adminId,targetId,action,oldValue,newValue,reason);return {oldValue,newValue}});const result=tx();queueTelegramUserBackup(targetId);res.json({ok:true,...result,player:db.prepare('SELECT telegram_id,username,balance,account_status,warning_count FROM users WHERE telegram_id=?').get(targetId)})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/admin/logs',auth,requireAdmin,(req,res)=>{const page=Math.max(1,Number(req.query.page)||1),limit=Math.min(100,Math.max(10,Number(req.query.limit)||40)),q=String(req.query.q||'').trim().slice(0,80);let where='1=1',params=[];if(q){where+=' AND (admin_id LIKE ? OR target_id LIKE ? OR action LIKE ? OR reason LIKE ?)';params=[`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`]}const total=db.prepare(`SELECT COUNT(*) AS n FROM admin_logs WHERE ${where}`).get(...params).n;const logs=db.prepare(`SELECT l.*,a.username AS admin_username,t.username AS target_username FROM admin_logs l LEFT JOIN users a ON a.telegram_id=l.admin_id LEFT JOIN users t ON t.telegram_id=l.target_id WHERE ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`).all(...params,limit,(page-1)*limit);res.json({logs,total,page,limit})});
app.post('/api/games/record',auth,(req,res)=>{const game=String(req.body?.game||''),eventId=String(req.body?.eventId||''),outcome=String(req.body?.outcome||'started'),wager=Math.max(0,Math.min(1e7,Number(req.body?.wager)||0)),payout=Math.max(0,Math.min(1e7,Number(req.body?.payout)||0));if(!['mines','coinflip','roulette','crash'].includes(game)||!eventId||eventId.length>100||!['started','win','loss'].includes(outcome))return res.status(400).json({error:'Некорректные данные игры.'});db.prepare(`INSERT INTO game_events(event_id,telegram_id,game,outcome,wager,payout) VALUES(?,?,?,?,?,?) ON CONFLICT(telegram_id,event_id) DO UPDATE SET outcome=excluded.outcome,wager=CASE WHEN excluded.wager>0 THEN excluded.wager ELSE game_events.wager END,payout=excluded.payout,updated_at=CURRENT_TIMESTAMP`).run(eventId,String(req.tgUser.id),game,outcome,wager,payout);queueTelegramUserBackup(String(req.tgUser.id));res.json({ok:true})});
app.get('/api/multiplayer/players',auth,(req,res)=>{const q=String(req.query.q||'').trim().replace(/[%_]/g,'').slice(0,50);if(q.length<2)return res.json({players:[]});const rows=db.prepare('SELECT telegram_id,username FROM users WHERE telegram_id<>? AND (telegram_id LIKE ? OR username LIKE ?) ORDER BY username LIMIT 30').all(String(req.tgUser.id),`%${q}%`,`%${q}%`).map(u=>({...u,presence:playerPresence(u.telegram_id)}));res.json({players:rows})});
app.get('/api/multiplayer/friends',auth,(req,res)=>{const id=String(req.tgUser.id);const friends=db.prepare("SELECT f.user_id,f.friend_id,f.status,f.created_at,CASE WHEN f.user_id=? THEN u2.username ELSE u1.username END AS username,CASE WHEN f.user_id=? THEN f.friend_id ELSE f.user_id END AS telegram_id,CASE WHEN f.user_id=? THEN 'sent' ELSE 'received' END AS direction FROM friends f JOIN users u1 ON u1.telegram_id=f.user_id JOIN users u2 ON u2.telegram_id=f.friend_id WHERE f.user_id=? OR f.friend_id=? ORDER BY f.created_at DESC").all(id,id,id,id,id).map(f=>({...f,presence:playerPresence(f.telegram_id)}));res.json({friends})});
app.post('/api/multiplayer/friends/request',auth,(req,res)=>{const id=String(req.tgUser.id),friend=String(req.body?.telegramId||'');if(!friend||friend===id)return res.status(400).json({error:'Выбери другого игрока.'});if(!db.prepare('SELECT 1 FROM users WHERE telegram_id=?').get(friend))return res.status(404).json({error:'Игрок не найден.'});try{db.prepare("INSERT INTO friends(user_id,friend_id,status) VALUES(?,?,'pending') ON CONFLICT(user_id,friend_id) DO UPDATE SET status=CASE WHEN friends.status='accepted' THEN 'accepted' ELSE 'pending' END").run(id,friend);res.json({ok:true})}catch(e){res.status(400).json({error:'Заявка уже отправлена.'})}});
app.post('/api/multiplayer/friends/respond',auth,(req,res)=>{const id=String(req.tgUser.id),friend=String(req.body?.telegramId||''),accept=req.body?.action==='accept';const row=db.prepare("SELECT 1 FROM friends WHERE user_id=? AND friend_id=? AND status='pending'").get(friend,id);if(!row)return res.status(404).json({error:'Входящая заявка не найдена.'});const tx=db.transaction(()=>{if(accept){db.prepare("UPDATE friends SET status='accepted' WHERE user_id=? AND friend_id=?").run(friend,id);db.prepare("INSERT INTO friends(user_id,friend_id,status) VALUES(?,?,'accepted') ON CONFLICT(user_id,friend_id) DO UPDATE SET status='accepted'").run(id,friend)}else db.prepare('DELETE FROM friends WHERE user_id=? AND friend_id=?').run(friend,id)});tx();res.json({ok:true})});
app.get('/api/multiplayer/rooms',auth,(req,res)=>{const id=String(req.tgUser.id);const rooms=db.prepare("SELECT DISTINCT r.* FROM rooms r LEFT JOIN room_players p ON p.room_id=r.id AND p.left_at IS NULL WHERE r.status IN ('waiting','active') AND (r.visibility='public' OR p.user_id=?) ORDER BY r.updated_at DESC LIMIT 50").all(id).map(r=>({id:r.id,joinCode:r.join_code,gameType:r.game_type,visibility:r.visibility,status:r.status,maxPlayers:r.max_players,creatorId:r.creator_id,players:db.prepare('SELECT COUNT(*) AS n FROM room_players WHERE room_id=? AND left_at IS NULL').get(r.id).n}));res.json({rooms})});
app.get('/api/multiplayer/bootstrap',auth,(req,res)=>{res.json({userId:String(req.tgUser.id),friends:db.prepare("SELECT f.friend_id AS telegram_id,u.username FROM friends f JOIN users u ON u.telegram_id=f.friend_id WHERE f.user_id=? AND f.status='accepted' ORDER BY u.username").all(String(req.tgUser.id)).map(x=>({...x,presence:playerPresence(x.telegram_id)})),rooms:db.prepare("SELECT r.id,r.join_code,r.game_type,r.visibility,r.status,r.max_players,r.creator_id,(SELECT COUNT(*) FROM room_players p WHERE p.room_id=r.id AND p.left_at IS NULL) AS players FROM rooms r LEFT JOIN room_players mine ON mine.room_id=r.id AND mine.user_id=? AND mine.left_at IS NULL WHERE r.status IN ('waiting','active') AND (r.visibility='public' OR mine.user_id=?) ORDER BY r.updated_at DESC LIMIT 50").all(String(req.tgUser.id),String(req.tgUser.id))})});
app.get('/api/multiplayer/invites',auth,(req,res)=>{const invites=db.prepare("SELECT i.room_id,i.invited_by,i.created_at,u.username AS inviter,r.game_type,r.join_code FROM room_invites i JOIN users u ON u.telegram_id=i.invited_by JOIN rooms r ON r.id=i.room_id WHERE i.invited_id=? AND i.status='pending' AND r.status IN ('waiting','active') ORDER BY i.id DESC LIMIT 30").all(String(req.tgUser.id));res.json({invites})});
app.post('/api/multiplayer/rooms',auth,(req,res)=>{const userId=String(req.tgUser.id),game=String(req.body?.gameType||'mines'),visibility=req.body?.visibility==='private'?'private':'public',max=Math.max(2,Math.min(8,Number(req.body?.maxPlayers)||4)),settings=req.body?.settings&&typeof req.body.settings==='object'?req.body.settings:{};if(!['mines','coinflip','roulette','crash'].includes(game))return res.status(400).json({error:'Неизвестная игра.'});let id,code;do{id=crypto.randomUUID();code=crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase()}while(db.prepare('SELECT 1 FROM rooms WHERE join_code=?').get(code));const tx=db.transaction(()=>{db.prepare('INSERT INTO rooms(id,join_code,creator_id,game_type,visibility,max_players,settings_json) VALUES(?,?,?,?,?,?,?)').run(id,code,userId,game,visibility,max,JSON.stringify(settings).slice(0,4000));db.prepare('INSERT INTO room_players(room_id,user_id) VALUES(?,?)').run(id,userId)});tx();res.json({room:roomInfo(id)})});
app.post('/api/multiplayer/rooms/join',auth,(req,res)=>{const id=String(req.tgUser.id),code=String(req.body?.code||'').trim().toUpperCase().slice(0,12),room=db.prepare('SELECT id FROM rooms WHERE join_code=?').get(code);if(!room)return res.status(404).json({error:'Комната по этому коду не найдена.'});try{res.json({room:joinRoom(room.id,id)})}catch(e){res.status(400).json({error:e.message})}});
app.get('/api/multiplayer/rooms/:id',auth,(req,res)=>{const roomId=String(req.params.id);if(!db.prepare('SELECT 1 FROM room_players WHERE room_id=? AND user_id=? AND left_at IS NULL').get(roomId,String(req.tgUser.id)))return res.status(403).json({error:'Сначала подключись к комнате.'});const room=roomInfo(roomId);if(!room)return res.status(404).json({error:'Комната не найдена.'});res.json({room})});
app.post('/api/multiplayer/rooms/leave',auth,(req,res)=>{const roomId=String(req.body?.roomId||''),userId=String(req.tgUser.id),room=db.prepare('SELECT * FROM rooms WHERE id=?').get(roomId);if(!room)return res.status(404).json({error:'Комната не найдена.'});const tx=db.transaction(()=>{db.prepare('UPDATE room_players SET left_at=CURRENT_TIMESTAMP WHERE room_id=? AND user_id=? AND left_at IS NULL').run(roomId,userId);const next=db.prepare('SELECT user_id FROM room_players WHERE room_id=? AND left_at IS NULL ORDER BY joined_at LIMIT 1').get(roomId);if(!next)db.prepare("UPDATE rooms SET status='closed',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(roomId);else db.prepare("UPDATE rooms SET creator_id=?,status=(SELECT CASE WHEN COUNT(*)>=2 THEN 'active' ELSE 'waiting' END FROM room_players WHERE room_id=? AND left_at IS NULL),updated_at=CURRENT_TIMESTAMP WHERE id=?").run(next.user_id,roomId,roomId)});tx();io.emit('presence:update',{userId,status:playerPresence(userId)});io.to(`room:${roomId}`).emit('room:presence',{roomId,room:roomInfo(roomId)});res.json({ok:true})});
app.post('/api/multiplayer/rooms/invite',auth,(req,res)=>{const roomId=String(req.body?.roomId||''),invited=String(req.body?.telegramId||''),userId=String(req.tgUser.id);if(!db.prepare('SELECT 1 FROM room_players WHERE room_id=? AND user_id=? AND left_at IS NULL').get(roomId,userId))return res.status(403).json({error:'Ты не участник комнаты.'});if(!db.prepare('SELECT 1 FROM friends WHERE user_id=? AND friend_id=? AND status=\'accepted\'').get(userId,invited))return res.status(400).json({error:'Приглашать можно только друзей.'});try{db.prepare("INSERT INTO room_invites(room_id,invited_by,invited_id) VALUES(?,?,?) ON CONFLICT(room_id,invited_id) DO UPDATE SET invited_by=excluded.invited_by,status='pending',created_at=CURRENT_TIMESTAMP").run(roomId,userId,invited);res.json({ok:true})}catch(e){res.status(400).json({error:'Не удалось отправить приглашение.'})}});
app.post('/api/multiplayer/invites/respond',auth,(req,res)=>{const roomId=String(req.body?.roomId||''),userId=String(req.tgUser.id),accept=req.body?.action==='accept',invite=db.prepare("SELECT id FROM room_invites WHERE room_id=? AND invited_id=? AND status='pending'").get(roomId,userId);if(!invite)return res.status(404).json({error:'Приглашение не найдено.'});db.prepare('UPDATE room_invites SET status=? WHERE id=?').run(accept?'accepted':'declined',invite.id);if(!accept)return res.json({ok:true});try{res.json({ok:true,room:joinRoom(roomId,userId)})}catch(e){res.status(400).json({error:e.message})}});
io.use((socket,next)=>{void(async()=>{try{const user=validateTelegramInitData(socket.handshake.auth?.initData);ensureUser(user);const id=String(user.id);if(channelBackupEnabled)await restoreTelegramUserFromChannel(id,user);const row=db.prepare('SELECT account_status FROM users WHERE telegram_id=?').get(id);if(row?.account_status==='blocked')throw Object.assign(new Error('Аккаунт заблокирован.'),{data:{code:'BLOCKED'}});telegramLoadedUsers.add(id);socket.data.userId=id;socket.data.user=user;next()}catch(e){next(Object.assign(new Error(e.message||'Не авторизован.'),{data:{code:'UNAUTHORIZED'}}))}})()});
io.on('connection',socket=>{const userId=socket.data.userId;socket.join("user:"+userId);connectedUsers.set(userId,(connectedUsers.get(userId)||0)+1);db.prepare('UPDATE users SET last_active=CURRENT_TIMESTAMP WHERE telegram_id=?').run(userId);io.emit('presence:update',{userId,status:playerPresence(userId)});socket.use((event,next)=>{const user=db.prepare('SELECT account_status FROM users WHERE telegram_id=?').get(userId);if(!user||user.account_status==='blocked')return next(new Error('Аккаунт заблокирован.'));db.prepare('UPDATE users SET last_active=CURRENT_TIMESTAMP WHERE telegram_id=?').run(userId);next()});const ack=(cb,data)=>{if(typeof cb==='function')cb(data)};socket.on('room:join',(payload={},cb)=>{const roomId=String(payload.roomId||'');if(!db.prepare("SELECT 1 FROM room_players rp JOIN rooms r ON r.id=rp.room_id WHERE rp.room_id=? AND rp.user_id=? AND rp.left_at IS NULL AND r.status IN ('waiting','active')").get(roomId,userId))return ack(cb,{ok:false,error:'Нет доступа к комнате.'});socket.join(`room:${roomId}`);const room=roomInfo(roomId);ack(cb,{ok:true,room});socket.to(`room:${roomId}`).emit('room:presence',{roomId,room})});socket.on('room:chat',(payload={},cb)=>{const roomId=String(payload.roomId||''),message=String(payload.message||'').trim().slice(0,500);if(!message)return ack(cb,{ok:false,error:'Сообщение пустое.'});if(!db.prepare('SELECT 1 FROM room_players WHERE room_id=? AND user_id=? AND left_at IS NULL').get(roomId,userId))return ack(cb,{ok:false,error:'Нет доступа к комнате.'});const result=db.prepare('INSERT INTO room_messages(room_id,user_id,message) VALUES(?,?,?)').run(roomId,userId,message);db.prepare('UPDATE rooms SET last_activity=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(roomId);const data=db.prepare('SELECT m.id,m.user_id,u.username,m.message,m.created_at FROM room_messages m JOIN users u ON u.telegram_id=m.user_id WHERE m.id=?').get(result.lastInsertRowid);io.to(`room:${roomId}`).emit('room:message',data);ack(cb,{ok:true})});socket.on('room:state',(payload={},cb)=>{const roomId=String(payload.roomId||''),state=payload.state;if(!state||typeof state!=='object'||JSON.stringify(state).length>12000)return ack(cb,{ok:false,error:'Игровое состояние слишком большое или некорректное.'});if(!db.prepare("SELECT 1 FROM room_players rp JOIN rooms r ON r.id=rp.room_id WHERE rp.room_id=? AND rp.user_id=? AND rp.left_at IS NULL AND r.status IN ('waiting','active')").get(roomId,userId))return ack(cb,{ok:false,error:'Нет доступа к комнате.'});const tx=db.transaction(()=>{const round=(db.prepare('SELECT COALESCE(MAX(round_no),0)+1 AS n FROM room_rounds WHERE room_id=?').get(roomId).n);const json=JSON.stringify(state);db.prepare('INSERT INTO room_rounds(room_id,round_no,actor_id,state_json) VALUES(?,?,?,?)').run(roomId,round,userId,json);db.prepare('UPDATE rooms SET state_json=?,last_activity=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,status=CASE WHEN status=\'waiting\' THEN \'active\' ELSE status END WHERE id=?').run(json,roomId);return round});const round=tx();io.to(`room:${roomId}`).emit('room:state',{roomId,round,actorId:userId,state});ack(cb,{ok:true,round})});socket.on('room:leave',(payload={},cb)=>{const roomId=String(payload.roomId||'');socket.leave(`room:${roomId}`);ack(cb,{ok:true})});socket.on('disconnect',()=>{const count=(connectedUsers.get(userId)||1)-1;if(count<=0){connectedUsers.delete(userId);io.emit('presence:update',{userId,status:playerPresence(userId)})}else connectedUsers.set(userId,count)})});
const roomCleanup=setInterval(()=>{const expired=db.prepare("SELECT id FROM rooms WHERE status IN ('waiting','active') AND last_activity<datetime('now','-30 minutes')").all();for(const room of expired)closeRoom(room.id)},60000);roomCleanup.unref();
app.use((err,req,res,next)=>{console.error('Request failed:',err);if(res.headersSent)return next(err);res.status(err.status||500).json({error:err.message||'Внутренняя ошибка сервера.'})});
let githubBackupTimer=null,renderPingTimer=null,telegramIndexRetryTimer=null;
  const shutdown=async(signal)=>{
   if(shuttingDown)return;shuttingDown=true;console.log(signal+' received; flushing player backups to Telegram before exit.');
   const forceExit=setTimeout(()=>{console.error('Shutdown deadline reached before Telegram backup finished.');process.exit(0)},28000);
   forceExit.unref?.();
   clearInterval(roomCleanup);clearInterval(githubBackupTimer);clearInterval(renderPingTimer);clearInterval(telegramIndexRetryTimer);if(telegramFlushTimer){clearTimeout(telegramFlushTimer);telegramFlushTimer=null}
   try{
    io.disconnectSockets(true);
    await Promise.race([
     new Promise(resolve=>{if(!httpServer.listening)return resolve();httpServer.close(()=>resolve())}),
     new Promise(resolve=>setTimeout(resolve,3000))
    ]);
    if(channelBackupEnabled){
     if(!telegramIndexLoaded)try{await loadTelegramBackupIndex()}catch(error){console.error('Could not load Telegram index during shutdown:',error.message)}
     if(telegramFlushPromise)await telegramFlushPromise;
     for(const row of db.prepare('SELECT telegram_id FROM users').all())pendingTelegramUsers.add(String(row.telegram_id));
     const deadline=Date.now()+20000;
     while(pendingTelegramUsers.size&&Date.now()<deadline){const ok=await flushTelegramBackupQueue(true);if(!ok)await new Promise(resolve=>setTimeout(resolve,1000))}
     if(pendingTelegramUsers.size)console.error('Telegram shutdown backup did not finish before the Render shutdown deadline.');
     else console.log('Telegram shutdown backup finished for all players.');
    }
    try{db.pragma('wal_checkpoint(FULL)');db.close()}catch(error){console.error('SQLite shutdown failed:',error.message)}
   }finally{
    clearTimeout(forceExit);
    process.exit(0);
   }
  };
  process.once('SIGTERM',()=>void shutdown('SIGTERM'));process.once('SIGINT',()=>void shutdown('SIGINT'));
if(channelBackupEnabled){
 try{await loadTelegramBackupIndex();if(!shuttingDown)queueUsersMissingFromTelegramIndex()}
 catch(error){console.error('Telegram backup index load failed:',error.message);telegramIndexRetryTimer=setInterval(async()=>{if(shuttingDown||telegramIndexLoaded)return;try{await loadTelegramBackupIndex();queueUsersMissingFromTelegramIndex();if(pendingTelegramUsers.size)void flushTelegramBackupQueue(true);clearInterval(telegramIndexRetryTimer)}catch(retryError){console.error('Telegram backup index retry failed:',retryError.message)}},30000);telegramIndexRetryTimer.unref()}
}else console.warn('Telegram channel backups are disabled. Set CHANNEL_ID in Render and add the bot as a channel administrator.');
  if(!shuttingDown&&GITHUB_CONFIGURED) {
    await backupDatabase();
    if(!shuttingDown){
     githubBackupTimer = setInterval(() => { void backupDatabase(); }, 5 * 60 * 1000);
     githubBackupTimer.unref();
     console.log('GitHub database, player log and statistics snapshots are scheduled every 5 minutes.');
    }
  } else if(!GITHUB_CONFIGURED) {
    console.warn('GitHub backups are disabled. Set GITHUB_BACKUP_REPO and GITHUB_BACKUP_TOKEN in Render.');
  }
  if(shuttingDown)return;
  httpServer.listen(PORT,()=>{
   console.log(`CS2 Market server listening on ${PORT}`);
   if(process.env.RENDER_EXTERNAL_URL){const pingUrl=process.env.RENDER_EXTERNAL_URL.replace(/\/+$/,'')+'/ping';renderPingTimer=setInterval(()=>{fetch(pingUrl,{signal:AbortSignal.timeout(10000)}).then(response=>{if(!response.ok)throw new Error('HTTP '+response.status)}).catch(error=>console.warn('Render self-ping failed:',error.message))},120000);renderPingTimer.unref();console.log('Render self-ping scheduled every 2 minutes.');}
   if(BOT_TOKEN&&TELEGRAM_WEBHOOK_URL&&TELEGRAM_WEBHOOK_SECRET)telegramApi('setWebhook',{url:TELEGRAM_WEBHOOK_URL,secret_token:TELEGRAM_WEBHOOK_SECRET,allowed_updates:['message','pre_checkout_query']},12000).then(()=>console.log('Telegram Stars webhook configured')).catch(error=>console.error('Telegram webhook setup failed:',error.message));
  });
}

startServer().catch(error => {
  console.error('Server startup failed:', error);
  process.exitCode = 1;
});
