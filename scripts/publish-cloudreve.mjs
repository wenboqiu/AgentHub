#!/usr/bin/env node
/**
 * 把 Tauri 打包产物（NSIS 安装包）通过 WebDAV 上传到 Cloudreve。
 *
 * 站点: https://share.wondergarden.top  (Cloudreve v4, WebDAV 端点 /dav)
 * 目标: cloudreve://my/Artifacts
 *
 * 用法:
 *   node scripts/publish-cloudreve.mjs --check     # 只校验账号 + 看目录
 *   node scripts/publish-cloudreve.mjs --dry-run   # 只找产物、不联网上传
 *   node scripts/publish-cloudreve.mjs             # 真正上传
 *   node scripts/publish-cloudreve.mjs --file=xxx  # 指定某个文件
 *   node scripts/publish-cloudreve.mjs --dir=Artifacts
 *
 * 凭据（任选其一，推荐 .env.local）:
 *   CLOUDREVE_URL=https://share.wondergarden.top
 *   CLOUDREVE_USER=you@example.com      # 登录邮箱 / 用户名
 *   CLOUDREVE_PASS=******               # 若开了两步验证，用「WebDAV 密码」
 *   CLOUDREVE_DIR=Artifacts             # 可选，缺省 Artifacts
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);

const hasFlag = (name) => ARGS.some((a) => a === `--${name}`);
const getArg = (name, fallback = '') => {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const log = {
  step: (msg) => console.log(`${BOLD}▶${RESET} ${msg}`),
  ok: (msg) => console.log(`${GREEN}✓${RESET} ${msg}`),
  warn: (msg) => console.log(`${YELLOW}!${RESET} ${msg}`),
  info: (msg) => console.log(`${DIM}  ${msg}${RESET}`),
  fail: (msg) => console.error(`${RED}✗ ${msg}${RESET}`),
};

/* ---------------------------------- env ---------------------------------- */

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env.local'));
loadEnvFile(path.join(ROOT, '.env'));

const dirArg = getArg('dir', process.env.CLOUDREVE_DIR ?? 'Artifacts').trim();
// Git Bash 会把纯 "/" 转成本地路径，一并当根目录处理
const dirLooksMangled = /^[A-Za-z]:[\\/]/.test(dirArg);
const remoteDir = hasFlag('root') || dirArg === '/' || dirLooksMangled
  ? ''
  : dirArg.replace(/^\/+|\/+$/g, '');
if (dirLooksMangled) {
  log.warn(`--dir=${dirArg} 被 Git Bash 转换了，按 WebDAV 根目录处理（等价 --root）`);
}

const CONFIG = {
  baseUrl: (process.env.CLOUDREVE_URL || 'https://share.wondergarden.top').replace(/\/+$/, ''),
  davPath: (process.env.CLOUDREVE_DAV_PATH || '/dav').replace(/\/+$/, ''),
  user: process.env.CLOUDREVE_USER || '',
  pass: process.env.CLOUDREVE_PASS || '',
  // 相对 WebDAV 账号根目录的路径；空 = 直接放账号根目录
  remoteDir,
  // 只用于打印「打开目录」链接的 Cloudreve 路径（WebDAV 账号根目录可能是 my 下的子目录）
  openPath: (process.env.CLOUDREVE_OPEN_PATH || `my${remoteDir ? '/' + remoteDir : ''}`).replace(/^\/+|\/+$/g, ''),
  keepVersions: (process.env.CLOUDREVE_KEEP_VERSIONS ?? '1') !== '0',
};

/** 拼接远端路径，remoteDir 为空时就是根目录 */
const R = (p) => (CONFIG.remoteDir ? `${CONFIG.remoteDir}/${p}` : p);
const dirLabel = CONFIG.remoteDir || '(WebDAV 根目录)';
const openUrl = `${CONFIG.baseUrl}/home?path=${encodeURIComponent(`cloudreve://${CONFIG.openPath}`)}`;

/* -------------------------------- 版本/产物 ------------------------------- */

async function readVersion() {
  const conf = JSON.parse(await fsp.readFile(path.join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
  return conf.version;
}

async function findInstaller(version) {
  const explicit = getArg('file');
  if (explicit) {
    const abs = path.isAbsolute(explicit) ? explicit : path.resolve(ROOT, explicit);
    if (!fs.existsSync(abs)) throw new Error(`指定的文件不存在: ${abs}`);
    return abs;
  }

  const bundleDir = path.join(ROOT, 'src-tauri/target/release/bundle');
  if (!fs.existsSync(bundleDir)) {
    throw new Error(`打包目录不存在: ${bundleDir}\n  先执行 npm run tauri build`);
  }

  const wanted = new Set(['.exe', '.msi', '.dmg', '.app', '.deb', '.rpm', '.AppImage', '.zip']);
  const stack = [bundleDir];
  const candidates = [];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (wanted.has(path.extname(entry.name)) && !entry.name.endsWith('.sig')) {
        const st = await fsp.stat(full);
        candidates.push({ full, name: entry.name, size: st.size, mtime: st.mtimeMs });
      }
    }
  }
  if (!candidates.length) throw new Error(`在 ${bundleDir} 下没找到安装包，先执行 npm run tauri build`);

  const exact = candidates.filter((c) => c.name.includes(`_${version}_`) || c.name.includes(`-${version}.`));
  const pool = exact.length ? exact : candidates;
  pool.sort((a, b) => b.mtime - a.mtime);
  if (!exact.length) {
    log.warn(`没找到版本号 ${version} 的产物，回退到最新的 ${pool[0].name}`);
  }
  return pool[0].full;
}

/* --------------------------------- WebDAV -------------------------------- */

const authHeader = () =>
  'Basic ' + Buffer.from(`${CONFIG.user}:${CONFIG.pass}`).toString('base64');

const encodePath = (p) =>
  p
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');

function davUrl(remotePath) {
  return `${CONFIG.baseUrl}${CONFIG.davPath}/${encodePath(remotePath)}`;
}

async function dav(method, remotePath, { body, headers = {}, isCollection = false } = {}) {
  let target = davUrl(remotePath);
  if (isCollection && !target.endsWith('/')) target += '/';
  const res = await fetch(target, {
    method,
    headers: { Authorization: authHeader(), ...headers },
    body,
    duplex: body && typeof body.pipe === 'function' ? 'half' : undefined,
  });
  if (res.status === 401) {
    throw new Error(
      'WebDAV 认证失败 (401)。检查 CLOUDREVE_USER / CLOUDREVE_PASS；\n' +
        '  如果账号开了两步验证，需要在 Cloudreve「设置 → 安全」里生成 WebDAV 专用密码。'
    );
  }
  return res;
}

async function propfind(remotePath, depth = 0) {
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/><d:getcontentlength/></d:prop></d:propfind>';
  return dav('PROPFIND', remotePath, {
    body,
    headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
    isCollection: true,
  });
}

async function remoteDirExists(dir) {
  if (!dir) return true;
  const res = await propfind(dir, 0);
  if (res.status >= 400 && res.status !== 404) throw new Error(`访问目录 ${dir} 失败: ${res.status}`);
  return res.status !== 404;
}

async function ensureRemoteDir(dir) {
  if (!dir) return;
  if (await remoteDirExists(dir)) return;
  log.info(`目录不存在，创建 ${dir}/`);
  const mk = await dav('MKCOL', dir, { isCollection: true });
  if (![200, 201, 204, 405].includes(mk.status)) {
    throw new Error(`创建目录失败: ${mk.status} ${await mk.text().catch(() => '')}`);
  }
}

function parseDisplayName(xml) {
  const m = xml.match(/<[^>]*displayname[^>]*>([^<]*)<\/[^>]*displayname>/i);
  return m ? m[1].trim() : '';
}

async function listRemote(dir) {
  const res = await propfind(dir, 1);
  if (res.status >= 400) return [];
  const text = await res.text();
  const hrefs = [...text.matchAll(/<[^>]*href[^>]*>([^<]+)<\/[^>]*href[^>]*>/gi)].map((m) => m[1]);
  return hrefs
    .slice(1)
    .map((h) => decodeURIComponent(h).replace(/^.*?\/dav\/?/, '/'))
    .filter(Boolean);
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

async function putFile(localPath, remotePath, size) {
  const started = Date.now();
  const stream = size > 64 * 1024 * 1024 ? fs.createReadStream(localPath) : await fsp.readFile(localPath);
  const res = await dav('PUT', remotePath, {
    body: stream,
    headers: {
      'Content-Type': 'application/octet-stream',
      ...(Buffer.isBuffer(stream) ? { 'Content-Length': String(size) } : {}),
    },
  });
  if (res.status >= 400) {
    throw new Error(`上传 ${remotePath} 失败: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log.ok(`${remotePath}  ${(size / 1024 / 1024).toFixed(2)} MB  ${secs}s`);
}

/* ---------------------------------- main --------------------------------- */

async function main() {
  const checkOnly = hasFlag('check');
  const dryRun = hasFlag('dry-run');

  const missingCreds = !CONFIG.user || !CONFIG.pass;
  if (missingCreds && !dryRun) {
    log.fail(`缺少凭据：请在项目根目录创建 .env.local（参考 .env.example），或设置环境变量`);
    log.info('CLOUDREVE_USER=你的登录邮箱');
    log.info('CLOUDREVE_PASS=你的密码 / WebDAV 密码');
    log.info('也可以用 --dry-run 先看看会传哪个文件');
    process.exit(1);
  }

  const version = await readVersion();
  const file = await findInstaller(version);
  const stat = await fsp.stat(file);
  const name = path.basename(file);

  console.log('');
  log.step(`站点      ${CONFIG.baseUrl}`);
  log.step(`上传位置  cloudreve://${CONFIG.openPath}   (WebDAV ${CONFIG.davPath}/${CONFIG.remoteDir})`);
  log.step(`版本      ${version}`);
  log.step(`产物      ${path.relative(ROOT, file)}  ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
  console.log('');

  if (dryRun) {
    log.ok('dry-run：未联网，未上传');
    return;
  }

  // 1. 连通性 + 目录
  log.step('校验 WebDAV 连接');
  const root = await propfind('', 1);
  if (root.status >= 400) throw new Error(`PROPFIND 根目录失败: ${root.status}`);
  const rootName = parseDisplayName(await root.text());
  log.ok(`认证通过${rootName ? `，WebDAV 根目录 = ${rootName}` : ''}`);

  if (checkOnly) {
    const exists = await remoteDirExists(CONFIG.remoteDir);
    if (!exists) log.warn(`${dirLabel}/ 还不存在，正式上传时会自动创建`);
    const items = await listRemote(exists ? CONFIG.remoteDir : '');
    log.step(`${dirLabel}/ 现有内容（最多列 20 项）`);
    for (const item of items.slice(0, 20)) log.info(item);
    if (!exists) {
      log.info('如果根目录就是 Artifacts 本身，设置 CLOUDREVE_DIR=/（或加 --root）让文件直接落在里面。');
    }
    return;
  }

  await ensureRemoteDir(CONFIG.remoteDir);

  // 2. 上传
  const hash = await sha256(file);
  if (CONFIG.keepVersions) {
    await ensureRemoteDir(R(`v${version}`));
    log.step('上传版本归档');
    await putFile(file, R(`v${version}/${name}`), stat.size);
  }

  log.step('更新 latest');
  await ensureRemoteDir(R('latest'));
  await putFile(file, R(`latest/${name}`), stat.size);
  const manifest = {
    name: 'AgentHub',
    version,
    file: name,
    size: stat.size,
    sha256: hash,
    builtAt: new Date().toISOString(),
    // WebDAV 直链需要 Basic Auth，这里给的是 Cloudreve 网页目录地址
    webUrl: openUrl,
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  const putManifest = await dav('PUT', R('latest/manifest.json'), {
    body: manifestBuf,
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(manifestBuf.length) },
  });
  if (putManifest.status >= 400) throw new Error(`写 manifest 失败: ${putManifest.status}`);
  log.ok(`${R('latest/manifest.json')}  ${version}`);

  console.log('');
  log.step('打开目录');
  console.log(`  ${openUrl}`);
  log.ok('完成');
}

main().catch((err) => {
  log.fail(err.message || String(err));
  process.exit(1);
});
